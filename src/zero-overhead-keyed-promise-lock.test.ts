/**
 * Copyright 2025 Ori Cohen https://github.com/ori88c
 * https://github.com/ori88c/zero-overhead-keyed-promise-lock
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * General note on testing concurrency in unit tests:
 * While ideal tests follow a strict Arrange-Act-Assert structure, rigorously testing
 * concurrency-oriented components often requires validating intermediate states.
 * Incorrect intermediate states can compromise the entire component's correctness,
 * making their verification essential.
 *
 * As with everything in engineering, this comes at a cost: verbosity.
 * Given that resilience is the primary goal, this is a small price to pay.
 */

import { ZeroOverheadKeyedLock } from './zero-overhead-keyed-promise-lock';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

interface MockErrorMessageInfo {
  round: number;
  key: string;
}

describe('ZeroOverheadKeyedLock tests', () => {
  describe('Happy path tests', () => {
    test('executeExclusive: should return the expected value when succeeds', async () => {
      // Arrange.
      const lock = new ZeroOverheadKeyedLock<number>();
      const key = 'user-9799789';
      const expectedValue = -295;
      const task = async (): Promise<number> => {
        return expectedValue;
      };

      // Pre-action validations.
      expect(lock.isActiveKey(key)).toBe(false);
      expect(lock.getCurrentExecution(key)).toBeUndefined();
      expect(lock.activeKeysCount).toBe(0);
      expect(lock.activeKeys).toEqual([]);

      // Act.
      const actualValue = await lock.executeExclusive(key, task);

      // Post-action validations.
      expect(actualValue).toBe(expectedValue);
      expect(lock.isActiveKey(key)).toBe(false);
      expect(lock.getCurrentExecution(key)).toBeUndefined();
      expect(lock.activeKeysCount).toBe(0);
      expect(lock.activeKeys).toEqual([]);
    });

    test('waitForAllExistingTasksToComplete: should resolve immediately if no task currently executes', async () => {
      const lock = new ZeroOverheadKeyedLock<void>();
      await lock.waitForAllExistingTasksToComplete();
      expect(lock.getCurrentExecution('mock_key')).toBeUndefined();
      expect(lock.activeKeysCount).toBe(0);
    });

    // prettier-ignore
    test(
      'executeExclusive: should process only one task at a time per key, and waitForAllExistingTasksToComplete ' +
      'should resolve only after *all* the currently pending and processed tasks are completed',
      async () => {
        jest.useFakeTimers();
        const lock = new ZeroOverheadKeyedLock<void>();
        const numberOfKeys = 176;
        const keys: readonly string[] = new Array<number>(numberOfKeys)
          .fill(0)
          .map((_, i) => i * 20)
          .map((num) => `user-${num}`);
        const roundToExecuteExclusivePromises: Promise<void>[][] = [];
        const initialBackpressurePerKey = 15;
        const taskDurationMs = 8000;
        let actualCompletedTasksCount = 0;
        const createTask = async (): Promise<void> => {
          await sleep(taskDurationMs);
          ++actualCompletedTasksCount;
        };
        const validateKeysActivity = (shouldBePresent: boolean): void => {
          for (const key of keys) {
            expect(lock.isActiveKey(key)).toBe(shouldBePresent);

            const currentExecutionPromise = lock.getCurrentExecution(key);
            if (shouldBePresent) {
              expect(currentExecutionPromise).toBeDefined();
            } else {
              expect(currentExecutionPromise).toBeUndefined();
            }
          }
        };

        // Initial validation.
        expect(lock.activeKeysCount).toBe(0);
        expect(lock.activeKeys).toEqual([]);
        validateKeysActivity(false);

        // Create a burst of tasks, inducing backpressure on the lock.
        // Add `initialBackpressurePerKey` pending tasks per key.
        for (let round = 0; round < initialBackpressurePerKey; ++round) {
          const pendingExecuteExclusivePromises: Promise<void>[] = keys.map((key) =>
            lock.executeExclusive(key, createTask),
          );
          roundToExecuteExclusivePromises.push(pendingExecuteExclusivePromises);

          // Trigger an event-loop iteration.
          await jest.advanceTimersByTimeAsync(0);

          validateKeysActivity(true);
          expect(lock.activeKeysCount).toBe(keys.length);
          expect(lock.activeKeys).toEqual(keys);
        }

        // Currrently, the number of pending tasks is initialBackpressurePerKey * numberOfKeys.
        let allTasksCompleted = false;
        const waitForCompletionOfAllTasksPromise: Promise<void> = (async () => {
          await lock.waitForAllExistingTasksToComplete();
          allTasksCompleted = true;
        })();

        let expectedCompletedTasksCount = 0;
        for (let round = 0; round < initialBackpressurePerKey; ++round) {
          expect(allTasksCompleted).toBe(false);
          expect(lock.activeKeysCount).toBe(keys.length);
          expect(lock.activeKeys).toEqual(keys);
          validateKeysActivity(true);

          // Simulate the completion of one task per key. This occurs because all tasks
          // have the same duration, and each key has an equal number of remaining tasks.
          await Promise.race([
            waitForCompletionOfAllTasksPromise,
            jest.advanceTimersByTimeAsync(taskDurationMs),
          ]);
          await Promise.all(roundToExecuteExclusivePromises[round]);

          // Each round, we complete one pending task per key.
          expectedCompletedTasksCount += numberOfKeys;
          expect(actualCompletedTasksCount).toBe(expectedCompletedTasksCount);
        }

        await waitForCompletionOfAllTasksPromise;
        expect(lock.activeKeysCount).toBe(0);
        expect(lock.activeKeys).toEqual([]);
        expect(allTasksCompleted).toBe(true);
        validateKeysActivity(false);
        jest.useRealTimers();
      },
    );

    test('getCurrentExecution should return the active task promise during execution', async () => {
      type ResultType = Record<string, number>;
      const mockResult: ResultType = { a: 1, b: 2 };

      let resolveTask: (value?: unknown) => void;
      const lock = new ZeroOverheadKeyedLock<ResultType>();
      const key = 'mock-key';

      const taskPromise = new Promise<ResultType>((res) => (resolveTask = res));
      const executeExclusivePromise = lock.executeExclusive(key, () => taskPromise);

      const validationRounds = 24;
      let currentExecution: Promise<ResultType>;
      for (let attempt = 0; attempt < validationRounds; ++attempt) {
        expect(lock.isActiveKey(key)).toBe(true);

        // getCurrentExecution should return the same Promise instance as long as
        // the current task is ongoing.
        if (currentExecution) {
          expect(lock.getCurrentExecution(key)).toBe(currentExecution);
        } else {
          currentExecution = lock.getCurrentExecution(key);
          expect(currentExecution).toBeDefined();
        }

        expect(lock.activeKeysCount).toBe(1);
        expect(lock.activeKeys).toEqual([key]);
      }

      resolveTask(mockResult);
      const result = await executeExclusivePromise;
      expect(result).toBe(mockResult);

      expect(lock.activeKeysCount).toBe(0);
      expect(lock.activeKeys).toEqual([]);
      expect(lock.isActiveKey(key)).toBe(false);
      expect(lock.getCurrentExecution(key)).toBeUndefined();
    });
  });

  describe('Negative path tests', () => {
    test('executeExclusive & getCurrentExecution: should reject when the key is empty or not a string', async () => {
      const lock = new ZeroOverheadKeyedLock<string>();
      const createTask = () => Promise.resolve<string>('mock-result');
      const invalidKeys = [
        '',
        0 as unknown as string,
        4 as unknown as string,
        -53.431 as unknown as string,
        undefined as string,
        null as string,
        true as unknown as string,
        { prop1: 'value1' } as unknown as string,
      ];

      for (const key of invalidKeys) {
        await expect(() => lock.executeExclusive(key, createTask)).rejects.toThrow();
        expect(() => lock.getCurrentExecution(key)).toThrow();
      }

      expect(lock.activeKeysCount).toBe(0);
      expect(lock.activeKeys).toEqual([]);
      await lock.waitForAllExistingTasksToComplete();
    });

    test('executeExclusive: should return the expected error when throws', async () => {
      const lock = new ZeroOverheadKeyedLock<string>();
      const key = 'mock-key';
      const expectedError = new Error('mock error');
      const createTask = async (): Promise<string> => {
        throw expectedError;
      };

      expect.assertions(5);
      try {
        await lock.executeExclusive(key, createTask);
      } catch (err) {
        expect(err).toBe(expectedError);

        // The event-driven eviction mechanism should remove the key after the task completes,
        // as long as no other task is pending (i.e., no backpressure).
        expect(lock.isActiveKey(key)).toBe(false);
        expect(lock.getCurrentExecution(key)).toBeUndefined();
      }

      expect(lock.activeKeysCount).toBe(0);
      expect(lock.activeKeys).toEqual([]);
      await lock.waitForAllExistingTasksToComplete();
    });

    // prettier-ignore
    test(
      'executeExclusive: should process only one task at a time per key, and waitForAllExistingTasksToComplete ' +
      'should resolve only after *all* the currently pending and processed tasks are completed, ' +
      'with all tasks rejecting',
      async () => {
        jest.useFakeTimers();
        const lock = new ZeroOverheadKeyedLock<void>();
        const numberOfKeys = 96;
        const keys: readonly string[] = new Array<number>(numberOfKeys)
          .fill(0)
          .map((_, i) => i * 25)
          .map((num) => `user-${num}`);
        const roundToExecuteExclusivePromises: Promise<void>[][] = [];
        const initialBackpressurePerKey = 12;
        const taskDurationMs = 6000;
        const createErrorMessage = (info: MockErrorMessageInfo): string =>
          `Task for ${info.key} failed during round ${info.round}`;
        const task = async (info: MockErrorMessageInfo): Promise<void> => {
          await sleep(taskDurationMs);
          throw new Error(createErrorMessage(info));
        };
        const validateKeysActivity = (shouldBePresent: boolean): void => {
          for (const key of keys) {
            expect(lock.isActiveKey(key)).toBe(shouldBePresent);

            const currentExecutionPromise = lock.getCurrentExecution(key);
            if (shouldBePresent) {
              expect(currentExecutionPromise).toBeDefined();
            } else {
              expect(currentExecutionPromise).toBeUndefined();
            }
          }
        };

        // Initial validation.
        expect(lock.activeKeysCount).toBe(0);
        expect(lock.activeKeys).toEqual([]);
        validateKeysActivity(false);

        // Create a burst of tasks, inducing backpressure on the lock.
        // Add `initialBackpressurePerKey` pending tasks per key.
        for (let round = 0; round < initialBackpressurePerKey; ++round) {
          const pendingExecuteExclusivePromises: Promise<void>[] = keys.map((key) =>
            lock.executeExclusive(key, () => task({ round, key })),
          );
          roundToExecuteExclusivePromises.push(pendingExecuteExclusivePromises);

          // Trigger an event-loop iteration.
          await jest.advanceTimersByTimeAsync(0);

          validateKeysActivity(true);
          expect(lock.activeKeysCount).toBe(keys.length);
          expect(lock.activeKeys).toEqual(keys);
        }

        // Currrently, the number of pending tasks is initialBackpressurePerKey * numberOfKeys.
        let allTasksCompleted = false;
        const waitForCompletionOfAllTasksPromise: Promise<void> = (async () => {
          await lock.waitForAllExistingTasksToComplete();
          allTasksCompleted = true;
        })();

        for (let round = 0; round < initialBackpressurePerKey; ++round) {
          expect(allTasksCompleted).toBe(false);
          expect(lock.activeKeysCount).toBe(keys.length);
          expect(lock.activeKeys).toEqual(keys);
          validateKeysActivity(true);

          // Simulate the completion of one task per key. This occurs because all tasks
          // have the same duration, and each key has an equal number of remaining tasks.
          await Promise.allSettled([
            ...roundToExecuteExclusivePromises[round],
            jest.advanceTimersByTimeAsync(taskDurationMs),
          ]);

          // Each round, we complete one pending task per key.
          let i = 0;
          for (const key of keys) {
            try {
              await roundToExecuteExclusivePromises[round][i++];
              expect(true).toBe(false); // The flow should not reach this point.
            } catch (err) {
              const expectedMessage = createErrorMessage({ round, key });
              expect(err.message).toEqual(expectedMessage);
            }
          }
        }

        await waitForCompletionOfAllTasksPromise;
        expect(lock.activeKeysCount).toBe(0);
        expect(lock.activeKeys).toEqual([]);
        expect(allTasksCompleted).toBe(true);
        validateKeysActivity(false);
        jest.useRealTimers();
      },
    );
  });
});
