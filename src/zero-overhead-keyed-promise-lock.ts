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

import { ZeroOverheadLock } from "zero-overhead-promise-lock";

/**
 * ZeroOverheadKeyedLock
 * 
 * The `ZeroOverheadKeyedLock` class provides a lightweight Promise-based locking mechanism 
 * for Node.js projects, ensuring the mutually exclusive execution of tasks **associated with 
 * the same key**.
 * 
 * Each task is identified by a non-empty string key. If a task is submitted while another 
 * task with the same key is still executing, it will be queued and executed only after all 
 * previously pending tasks for that key have completed (whether resolved or rejected). 
 * Effectively, each key maintains a FIFO queue, ensuring that tasks execute sequentially.
 * 
 * ### Race Conditions: How Are They Possible in Single-Threaded JavaScript?
 * In Node.js, synchronous code blocks - those that do *not* contain an `await` keyword - are
 * guaranteed to execute within a single event-loop iteration. These blocks inherently do not
 * require synchronization, as their execution is mutually exclusive by definition and cannot
 * overlap.
 * In contrast, asynchronous tasks that include at least one `await`, necessarily span across
 * multiple event-loop iterations. Such tasks may require synchronization, when overlapping
 * executions could result in an inconsistent or invalid state.
 * In this regard, JavaScript's single-threaded nature differs inherently from that of
 * single-threaded C code, for example.
 * 
 * ### Under the Hood
 * Implementation-wise, the keyed lock maintains a map from each key to its corresponding 
 * (non-keyed) lock. In other words, this component **leverages a well-tested**, simpler 
 * building block while focusing on key management.
 * Locks associated with unused keys are automatically removed in an event-driven manner,
 * as a post-processing step after each critical section execution.
 * 
 * ### Modern API Design
 * Traditional lock APIs require explicit acquire and release steps, adding overhead and
 * responsibility on the user.
 * In contrast, `ZeroOverheadKeyedLock` manages task execution, abstracting away these details
 * and reducing user responsibility. The acquire and release steps are handled implicitly by the
 * execution method, reminiscent of the RAII idiom in C++.
 * 
 * ### Graceful Teardown
 * Task execution promises are tracked by the lock instance, ensuring no dangling promises.
 * This enables graceful teardown via the `waitForAllExistingTasksToComplete` method, in
 * scenarios where it is essential to ensure that all tasks - whether already executing or
 * queued - are fully processed before proceeding.
 * Examples include application shutdowns (e.g., `onModuleDestroy` in Nest.js applications)
 * or maintaining a clear state between integration tests.
 */
export class ZeroOverheadKeyedLock<T> {
  private readonly _keyToLock = new Map<string, ZeroOverheadLock<T>>();

  /**
   * Returns the number of currently active keys. An active key is associated
   * with an ongoing (not yet completed) task.
   * The time complexity of this operation is O(1).
   * 
   * @returns The number of currently active keys.
   */
  public get activeKeysCount(): number {
    return this._keyToLock.size;
  }

  /**
   * Returns an array of currently active keys. An active key is associated
   * with an ongoing (not yet completed) task.
   * The time complexity of this operation is O(active-keys).
   * 
   * @returns An array of currently active keys.
   */
  public get activeKeys(): string[] {
    return Array.from(this._keyToLock.keys());
  }

  /**
   * Indicates whether the provided key is currently associated with an ongoing task
   * (i.e., the task is not yet completed).
   * The time complexity of this operation is O(1).
   * 
   * ### Check-and-Abort Friendly
   * This property is particularly useful in "check and abort" scenarios, where an
   * operation should be skipped or aborted if the key is currently held by another
   * task.
   * 
   * @param key A non-empty string representing the key associated with a task.
   * @returns `true` if there is an active (ongoing) task associated with the
   *          given key, `false` otherwise.
   */
  public isActiveKey(key: string): boolean {
    return this._keyToLock.has(key);
  }

  /**
   * Executes a given task exclusively, ensuring that only one task associated with the same key
   * can run at a time. It resolves or rejects when the task finishes execution, returning the
   * task's value or propagating any error it may throw.
   * 
   * If a task is submitted while another task with the same key is still executing, it will
   * be queued and executed only after all previously pending tasks for that key have completed
   * (whether resolved or rejected). 
   * Effectively, each key maintains a FIFO queue, ensuring that tasks execute sequentially.
   * 
   * ### Real-World Example: Batch Processing of Kafka Messages
   * Suppose you are consuming a batch of Kafka messages from the same partition concurrently, but
   * need to ensure sequential processing for messages associated with the same key. For example,
   * each message may represent an action on a user account, where processing multiple actions
   * concurrently could lead to race conditions.
   * Kafka experts might suggest increasing the number of partitions to ensure sequential processing
   * per partition. However, in practice, this approach can be costly. As a result, it is not uncommon
   * to prefer batch-processing messages from the same partition rather than increasing the partition
   * count.
   * A keyed lock ensures sequential processing of same-key messages during batch processing, e.g.,
   * by using the UserID as the key to avoid concurrent operations on the same user account.
   * 
   * @param key A non-empty string key associated with the task. For example, the UserID is a
   *            suitable key to ensure sequential operations on a user account.
   * @param criticalTask The asynchronous task to execute exclusively, ensuring it does not 
   *                     overlap with any other execution associated with the same key.
   * @throws Error thrown by the task itself.
   * @returns A promise that resolves with the task's return value or rejects with its error.
   */
  public async executeExclusive(key: string, criticalTask: () => Promise<T>): Promise<T> {
    const lock = this._getOrCreateLock(key);

    return lock.executeExclusive(async (): Promise<T> => {
      try {
        const taskResult = await criticalTask();
        return taskResult;
      } finally {
        // Post-processing: Free up the lock instance if unused.
        if (lock.pendingTasksCount === 0) {
          this._keyToLock.delete(key);
        }
      }
    });
  }

  /**
   * Exposes the currently executing task's promise for a specific key, if one is active.
   * Note that the returned promise may throw if the active task encounters an error.
   *
   * ### Smart Reuse
   * This property is useful in scenarios where launching a duplicate task is wasteful.
   * Instead of scheduling a new task, consumers can **await the ongoing execution** to
   * avoid redundant operations.
   *
   * ### Usage Example
   * For example, assume a Kafka message handler receives an event to provision an account
   * for a newly onboarded user. Since this operation should not be duplicated, you may
   * choose to wait for the current task to complete, if one is already in progress:
   * ```
   * const ongoing = onboardingLock.getCurrentExecution(userID);
   * if (ongoing) {
   *   await ongoing;
   * } else {
   *   await onboardingLock.executeExclusive(userID, onboardUserTask);
   * }
   * ```
   * #### Important Consideration
   * Please note that regardless of the scope of this example, an onboarding operation
   * should be implemented in an idempotent manner, even with this optimization.
   * In other words, developers should always account for the possibility of redundant executions.
   *
   * @param key A non-empty string key associated with the task.
   * @returns The currently executing task’s promise for the specified key, or `undefined`
   *          if no task is currently executing for that key.
   */
  public getCurrentExecution(key: string): Promise<T> | undefined {
    const lock = this._getLockIfExists(key);
    return lock?.currentExecution;
  }

  /**
   * Waits for the completion of all tasks that are *currently* pending or executing.
   *
   * This method is particularly useful in scenarios where it is essential to ensure that
   * all tasks - whether already executing or queued - are fully processed before proceeding.
   * Examples include application shutdowns (e.g., `onModuleDestroy` in Nest.js applications)
   * or maintaining a clear state between unit tests.
   * This need is especially relevant in Kubernetes ReplicaSet deployments. When an HPA controller
   * scales down, pods begin shutting down gracefully.
   *
   * ### Graceful Teardown
   * The returned promise only accounts for tasks registered at the time this method is called.
   * If this method is being used as part of a graceful shutdown process, the **caller must ensure**
   * that no additional tasks are registered after this method is called.
   * If there is any uncertainty about new tasks being registered, consider using the following pattern: 
   * ```ts
   * while (lock.activeKeysCount > 0) {
   *   await lock.waitForAllExistingTasksToComplete()
   * }
   * ```
   *
   * @returns A promise that resolves once all tasks that were pending or executing at the time
   *          of invocation are completed.
   */
  public async waitForAllExistingTasksToComplete(): Promise<void> {
    if (this._keyToLock.size === 0) {
      return;
    }

    const activeLocks = Array.from(this._keyToLock.values());
    const waitForCompletionPromises = activeLocks.map(lock => lock.waitForAllExistingTasksToComplete());
    await Promise.allSettled(waitForCompletionPromises);
  }

  private _validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new Error(`Key must be a non-empty string. Received: "${key}"`);
    }
  }

  private _getOrCreateLock(key: string): ZeroOverheadLock<T> {
    this._validateKey(key);

    let lock: ZeroOverheadLock<T> = this._keyToLock.get(key);
    if (!lock) {
      lock = new ZeroOverheadLock<T>();
      this._keyToLock.set(key, lock);
    }

    return lock;
  }

  private _getLockIfExists(key: string): ZeroOverheadLock<T> | undefined {
    this._validateKey(key);
    return this._keyToLock.get(key);
  }
}
