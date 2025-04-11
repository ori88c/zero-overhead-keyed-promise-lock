<h2 align="middle">zero-overhead-keyed-promise-lock</h2>

The `ZeroOverheadKeyedLock` class implements a modern Promise-lock for Node.js projects, enabling users to ensure the mutually exclusive execution of tasks **associated with the same key**.  
Effectively, a keyed lock functions as a temporary FIFO task queue per key. The key acts as an identifier for the queue, which exists only while tasks are pending or executing for that key.

A plausible use case is batch-processing Kafka messages from the same partition, where each message is linked to an entity-specific key (e.g., a User Account ID). By using a keyed lock, messages with the **same key** can be processed **sequentially**, while still leveraging Kafka’s client support for batch processing. This prevents race conditions when concurrent execution of same-key messages could lead to inconsistencies.

This package extends [zero-overhead-promise-lock](https://www.npmjs.com/package/zero-overhead-promise-lock) by adding support for keyed locking. If your use case involves only a few fixed keys for tasks known at compile time (e.g., bulk writes to a database), using multiple instances of the non-keyed lock may be a viable alternative.

## Table of Contents

* [Key Features](#key-features)
* [API](#api)
* [Getter Methods](#getter-methods)
* [Use Case Example: Batch processing by a Kafka Consumer](#use-case-example)
* [Race Conditions: How Are They Possible in Single-Threaded JavaScript?](#race-conditions)
* [Other Use Cases: Beyond Race Condition Prevention](#other-use-cases)
* [Modern API Design](#modern-api-design)
* [Opt for Atomic Operations When Working Against External Resources](#opt-atomic-operations)
* [License](#license)

## Key Features :sparkles:<a id="key-features"></a>

- __Key-wise Mutual Exclusiveness :lock:__: Ensures the mutually exclusive execution of tasks **associated with the same key**, either to prevent potential race conditions caused by tasks spanning across multiple event-loop iterations, or to optimize performance.
- __Graceful Teardown :hourglass_flowing_sand:__: Await the completion of all currently pending and executing tasks using the `waitForAllExistingTasksToComplete` method. Example use cases include application shutdowns (e.g., `onModuleDestroy` in Nest.js applications) or maintaining a clear state between unit-tests. A particularly interesting use case is in **batch processing handlers**, where it allows you to signal the completion of all event handlers associated with a batch.
- __"Check-and-Abort" Friendly :see_no_evil:__: The `isActiveKey` getter allows skipping or aborting operations if a lock is already held.
- __Smart Reuse :recycle:__: In scenarios where launching a duplicate task would be wasteful (e.g., refreshing a shared resource or cache), consumers can **await the ongoing execution instead of scheduling a new one**. This is enabled via the `getCurrentExecution` method, which exposes the currently executing task's promise for a specific key, if one is active.
- __Active Key Metrics :bar_chart:__: The `activeKeys` getter provides real-time insight into currently active keys - i.e., keys associated with ongoing tasks.
- __Even-Driven Eviction of Stale Keys__: Automatically removes internal locks for keys with no pending or ongoing tasks, ensuring the lock never retains stale keys.
- __Comprehensive documentation :books:__: Fully documented to provide rich IDE tooltips and enhance the development experience.
- __Thoroughly Tested :test_tube:__: Covered by extensive unit tests to ensure reliability.
- __Minimal External Dependencies__: Internally manages multiple instances of [zero-overhead-promise-lock](https://www.npmjs.com/package/zero-overhead-promise-lock), one per active key. This package focuses on efficient resource management while leveraging a well-tested foundation. Both packages are maintained by the same author :blue_heart:, and all other dependencies are dev-only.
- __ES2020 Compatibility__: The `tsconfig` target is set to ES2020.
- TypeScript support.

## API :globe_with_meridians:<a id="api"></a>

The `ZeroOverheadKeyedLock` class provides the following methods:

* __executeExclusive__: Executes the given task in a controlled manner, once the lock is available. It resolves or rejects when the task finishes execution, returning the task's value or propagating any error it may throw.
* __waitForAllExistingTasksToComplete__: Waits for the completion of all tasks that are *currently* pending or executing. This method is particularly useful in scenarios where it is essential to ensure that all tasks - whether already executing or queued - are fully processed before proceeding. Examples include **application shutdowns** (e.g., `onModuleDestroy` in Nest.js applications) or maintaining a clear state between unit tests.
* __isActiveKey__: Indicates whether the provided key is currently associated with an ongoing task (i.e., the task is not yet completed). This property is particularly useful in "check and abort" scenarios, where an operation should be skipped or aborted if the key is currently held by another task.
* __getCurrentExecution__: Exposes the currently executing task's promise for a specific key, if one is active. This is useful in scenarios where launching a duplicate task would be wasteful - consumers can simply **await the ongoing execution instead**. This feature enhances the lock’s versatility and supports advanced usage patterns.

If needed, refer to the code documentation for a more comprehensive description of each method.

## Getter Methods :mag:<a id="getter-methods"></a>

The `ZeroOverheadKeyedLock` class provides the following getter methods to reflect the current lock's state:

* __activeKeysCount__: Indicates the number of currently active keys. An active key is associated with an ongoing (not yet completed) task.
* __activeKeys__: Returns an array of currently active keys.

## Use Case Example: Batch processing by a Kafka Consumer :package:<a id="use-case-example"></a>

In Kafka consumer configurations, the most common approach is to consume messages sequentially from the same partition while potentially consuming from multiple partitions concurrently. For example, if a Kafka consumer is consuming from 5 partitions concurrently, at most 5 message event handlers will be in progress at the same time.

The primary reason for sequential processing within the same partition is that some messages should not be processed concurrently - such as actions on the same user account (e.g., buy/sell stocks). By assigning a key property to each Kafka message, messages with the same key will be guaranteed to reside in the same partition. Since there is a one-to-one mapping between partitions and consumers, all messages with the same key will be processed by the same consumer, eliminating the risk of concurrently processing same-key messages by multiple consumers.

To increase concurrency, one option is to increase the number of partitions and consume from them concurrently. However, batch processing in the context of a Kafka consumer offers distinct advantages, depending on the use case.  
By grouping messages into batches, you reduce the overhead of consuming and processing each message individually—particularly when processing involves complex logic or external resource calls (e.g., batch operations in MongoDB). This can significantly improve throughput. Instead of making individual requests to external services or databases for each message, you can batch several messages together, making fewer, larger requests and thus reducing overall network latency and resource contention.

However, batch processing does not guarantee the sequential processing of same-key messages. To address this, a keyed lock can be employed, effectively introducing a temporary FIFO task queue per key.

```ts
import { ZeroOverheadKeyedLock } from 'zero-overhead-keyed-promise-lock';
import { Kafka, Consumer, EachBatchPayload } from 'kafkajs';
import { IStockOrder } from './stock-order.interfaces';

export class StockOrdersConsumer {
  // Initialization methods are omitted for brevity in this example.

  public async startConsuming(): Promise<void> {
    // ...
    await this._consumer.run({
      eachBatch: this._handleBatch.bind(this)
    });
  }

  private async _handleBatch(payload: EachBatchPayload): Promise<void> {
    const orderMessages = payload.batch.messages;

    // Orders from the same user must be processed sequentially.  
    // We assume the Producer actor assigns a unique user account ID as the key. 
    const userLock = new ZeroOverheadKeyedLock<void>();

    // Register all batch orders simultaneously, then wait for their completion.
    for (const { value, key } of orderMessages) {
      const order: IStockOrder = JSON.parse(value.toString());
      const userID = key.toString();
      // The `executeExclusive` method returns a Promise, but we don't await
      // it here, as the individual task completion is not relevant.
      userLock.executeExclusive(userID, () => this._processOrder(order));
    }

    // Graceful teardown is not only important during application shutdowns;
    // in this case, it is used to signal the Kafka client that all batch
    // messages have been processed.
    await userLock.waitForAllExistingTasksToComplete();
  }

  private async _processOrder(order: IStockOrder): Promise<void> {
    // Stock order handling goes here.
  }
}
```

Unfortunately, at least in the JavaScript ecosystem, we cannot control the batch size by message **count**. Instead, Kafka clients allow setting only a maximum cumulative message size in bytes. As a result, in real-world scenarios, it is often necessary to use a Promise Semaphore to limit the number of batch messages processed concurrently.  
The following example demonstrates how to extend the previous implementation to impose a concurrency limit on processed orders per batch. This is achieved using the [zero-backpressure-semaphore-typescript](https://www.npmjs.com/package/zero-backpressure-semaphore-typescript) package, which is maintained by the same author as this package. :blue_heart:
```ts
import { ZeroOverheadKeyedLock } from 'zero-overhead-keyed-promise-lock';
import { ZeroBackpressureSemaphore } from 'zero-backpressure-semaphore-typescript';
import { Kafka, Consumer, EachBatchPayload } from 'kafkajs';
import { IStockOrder } from './stock-order.interfaces';

const MAX_BATCH_CONCURRENCY = 32;

export class StockOrdersConsumer {
  // Initialization methods are omitted for brevity in this example.

  public async startConsuming(): Promise<void> {
    // ...
    await this._consumer.run({
      eachBatch: this._handleBatch.bind(this)
    });
  }

  private async _handleBatch(payload: EachBatchPayload): Promise<void> {
    const orderMessages = payload.batch.messages;

    const semaphore = new ZeroBackpressureSemaphore<void>(MAX_BATCH_CONCURRENCY);
    const userLock = new ZeroOverheadKeyedLock<void>();

    for (const { value, key } of orderMessages) {
      const order: IStockOrder = JSON.parse(value.toString());
      const userID = key.toString();
      const alreadyActive = userLock.isActiveKey(userID);
      const executeExclusive = () => userLock.executeExclusive(
        userID,
        () => this._processOrder(order)
      );
      if (alreadyActive) {
        // No need to await; this key already occupies capacity in the semaphore.
        // In other words, the semaphore is currently processing a previous order
        // belonging to the current userID.
        executeExclusive();
        continue;
      }

      await semaphore.startExecution(executeExclusive);
    }

    // Graceful teardown is not only important during application shutdowns;
    // in this case, it is used to signal the Kafka client that all batch
    // messages have been processed.
    await userLock.waitForAllExistingTasksToComplete();
  }

  private async _processOrder(order: IStockOrder): Promise<void> {
    // Stock order handling goes here.
  }
}
```

It is crucial to avoid resolving a batch handler **too early**. Once the batch handler resolves, the Kafka client updates the processed offsets. If a message handler resolves before processing is fully completed, and the container crashes before all batch messages are handled, Kafka **may not reassign those messages to another consumer**, leading to potential data loss.

#### Graceful Shutdown Strategy for StockOrdersConsumer

Note that the examples above implement a graceful teardown only for the batch handling method, not for the `StockOrdersConsumer` component itself. Implementing a full teardown for `StockOrdersConsumer` can be challenging, as locks and/or semaphores are created and disposed per batch.

A feasible approach is to introduce a private `_activeLocks` property to track currently active locks. Then, a dedicated teardown method (e.g., `onDestroy`, `onShutdown`, `terminate`) can invoke the locks' graceful teardown mechanism, ensuring a **deterministic** shutdown.  
Consider the following adaptation, which abstracts away irrelevant details:
```ts
import { ZeroOverheadKeyedLock } from 'zero-overhead-keyed-promise-lock';
import { ZeroBackpressureSemaphore } from 'zero-backpressure-semaphore-typescript';
import { Kafka, Consumer, EachBatchPayload } from 'kafkajs';
import { IStockOrder } from './stock-order.interfaces';

export class StockOrdersConsumer {
  private readonly _activeLocks = new Set<ZeroOverheadKeyedLock<void>>();

  // Initialization methods are omitted for brevity in this example.

  public async startConsuming(): Promise<void> {
    // Implementation goes here.
  }

  public async onDestroy(): Promise<void> {
    await this._consumer.disconnect();

    // Message event handlers may still be executing.
    while (this._activeLocks.size > 0) {
      const locks = Array.from(this._activeLocks.keys());
      const waitForCompletionPromises = locks.map(lock => lock.waitForAllExistingTasksToComplete());
      await Promise.all(waitForCompletionPromises);
    }
  }

  private async _handleBatch(payload: EachBatchPayload): Promise<void> {
    const userLock = new ZeroOverheadKeyedLock<void>();
    this._activeLocks.add(userLock);

    // Implementation goes here.

    await userLock.waitForAllExistingTasksToComplete();
    this._activeLocks.delete(userLock);
  }
}
```

Note that a single Kafka consumer may be subscribed to multiple partitions and might perform batch processing for each. Refer to the `partitionsConsumedConcurrently` attribute in the 'kafkajs' package for more details.

## Race Conditions: How Are They Possible in Single-Threaded JavaScript? :checkered_flag:<a id="race-conditions"></a>

Unlike single-threaded C code, the event-loop architecture used in modern JavaScript runtime environments introduces the possibility of race conditions, especially for asynchronous tasks that span multiple event-loop iterations.

In Node.js, synchronous code blocks - those that do **not** contain an `await` keyword - are guaranteed to execute within a single event-loop iteration. These blocks inherently do not require synchronization, as their execution is mutually exclusive by definition and cannot overlap.  
In contrast, asynchronous tasks that include at least one `await`, necessarily span across **multiple event-loop iterations**. Such tasks may require synchronization to prevent overlapping executions that could lead to **race conditions**, resulting in inconsistent or invalid states. Such races occur when event-loop iterations from task A **interleave** with those from task B, each unaware of the other and **potentially acting on an intermediate state**.

## Other Use Cases: Beyond Race Condition Prevention :arrow_right:<a id="other-use-cases"></a>

Additionally, locks are sometimes employed **purely for performance optimization**, such as throttling, rather than for preventing race conditions. In such cases, the lock effectively functions as a semaphore with a concurrency of 1.

For example, limiting concurrent access to a shared resource may be necessary to reduce contention or meet operational constraints. In such cases, locks are employed as a semaphore with a concurrency limit of 1, ensuring that no more than one operation is executed at a time.

## Modern API Design :rocket:<a id="modern-api-design"></a>

Traditional lock APIs require explicit *acquire* and *release* steps, adding overhead and responsibility for the user. Additionally, they introduce the **risk of deadlocking the application** if one forgets to *release*, for example, due to a thrown exception.

In contrast, `ZeroOverheadKeyedLock` manages task execution, abstracting away these details and reducing user responsibility. The *acquire* and *release* steps are handled implicitly by the `executeExclusive` method, reminiscent of the RAII idiom in C++.

## Opt for Atomic Operations When Working Against External Resources :key:<a id="opt-atomic-operations"></a>

A common example of using locks is the READ-AND-UPDATE scenario, where concurrent reads of the same value can lead to erroneous updates. While such examples are intuitive, they are often less relevant in modern applications due to advancements in databases and external storage solutions. Modern databases, as well as caches like Redis, provide native support for atomic operations. **Always prioritize leveraging atomicity in external resources** before resorting to in-memory locks.

### Example: Incrementing a Counter in MongoDB
Consider the following function that increments the number of product views for the last hour in a MongoDB collection. Using two separate operations, this implementation introduces a race condition:
```ts
async function updateViews(products: Collection<IProductSchema>, productID: string): Promise<void> {
  const product = await products.findOne({ _id: productID }); // Step 1: Read
  if (!product) return;

  const currentViews = product?.hourlyViews ?? 0;
  await products.updateOne(
    { _id: productID },
    { $set: { hourlyViews: currentViews + 1 } } // Step 2: Update
  );
}
```
The race condition occurs when two or more processes or concurrent tasks (Promises within the same process) execute this function simultaneously, potentially leading to incorrect counter values. This can be mitigated by using MongoDB's atomic `$inc` operator, as shown below:
```ts
async function updateViews(products: Collection<IProductSchema>, productID: string): Promise<void> {
    await products.updateOne(
        { _id: productID },
        { $inc: { hourlyViews: 1 } } // Atomic increment
    );
}
```
By combining the read and update into a single atomic operation, the code avoids the need for locks and improves both reliability and performance.

## License :scroll:<a id="license"></a>

[Apache 2.0](LICENSE)
