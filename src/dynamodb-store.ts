import type {
  DmutexDynamoDBAttributeValue,
  DmutexDynamoDBClient,
  DynamoDBDMutexOptions,
} from "./types";
import type { DMutexStore } from "./store";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_INTERVAL_MS = 250;

const TABLE_NAME_PATTERN = /^[a-zA-Z0-9_.-]{3,255}$/;

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const isNamedDynamoDBError = (error: unknown, name: string) => {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === name
  );
}

const validateTableName = (tableName: string) => {
  if (!TABLE_NAME_PATTERN.test(tableName)) {
    throw new Error(
      "DynamoDB table names must be 3-255 characters and contain only letters, numbers, underscores, hyphens, or dots",
    );
  }
}

const numberAttributeToDate = (attribute: DmutexDynamoDBAttributeValue | undefined) => {
  if (!attribute?.N) {
    return null;
  }

  return new Date(Number(attribute.N));
}

export class DynamoDBDMutexStore implements DMutexStore {
  private dynamoDBClient: DmutexDynamoDBClient
  private tableName: string
  private createTable: boolean
  private readyTimeoutMs: number
  private readyPollIntervalMs: number
  private readyPromise: Promise<void>

  constructor(serviceName: string, dynamoDBClient: DmutexDynamoDBClient, options: DynamoDBDMutexOptions) {
    this.dynamoDBClient = dynamoDBClient;
    this.tableName = options.tableName ?? `${options.tablePrefix ?? "_dmutex_"}${serviceName}`;
    validateTableName(this.tableName);

    this.createTable = options.createTable ?? true;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyPollIntervalMs = options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
    this.readyPromise = this.initialize();
  }

  public ready = async () => {
    await this.readyPromise;
  }

  private initialize = async () => {
    if (this.createTable) {
      try {
        await this.dynamoDBClient.createTable({
          TableName: this.tableName,
          AttributeDefinitions: [
            { AttributeName: "key", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "key", KeyType: "HASH" },
          ],
          BillingMode: "PAY_PER_REQUEST",
        });
      } catch (error) {
        if (!isNamedDynamoDBError(error, "ResourceInUseException")) {
          throw error;
        }
      }
    }

    await this.waitForTableReady();
  }

  private waitForTableReady = async () => {
    const deadline = Date.now() + this.readyTimeoutMs;

    while (true) {
      try {
        const result = await this.dynamoDBClient.describeTable({
          TableName: this.tableName,
        });

        if (result.Table?.TableStatus === "ACTIVE") {
          return;
        }
      } catch (error) {
        if (!isNamedDynamoDBError(error, "ResourceNotFoundException")) {
          throw error;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for DynamoDB table ${this.tableName} to become ACTIVE`);
      }

      await sleep(this.readyPollIntervalMs);
    }
  }

  public acquire = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));

    try {
      await this.dynamoDBClient.putItem({
        TableName: this.tableName,
        Item: {
          key: { S: key },
          value: { S: token },
          expiredAt: { N: String(expiredAt.getTime()) },
        },
        ConditionExpression: "attribute_not_exists(#key) OR #expiredAt <= :now",
        ExpressionAttributeNames: {
          "#key": "key",
          "#expiredAt": "expiredAt",
        },
        ExpressionAttributeValues: {
          ":now": { N: String(now) },
        },
      });

      return expiredAt;
    } catch (error) {
      if (isNamedDynamoDBError(error, "ConditionalCheckFailedException")) {
        return null;
      }

      throw error;
    }
  }

  public release = async (key: string, token: string) => {
    await this.ready();

    try {
      await this.dynamoDBClient.deleteItem({
        TableName: this.tableName,
        Key: {
          key: { S: key },
        },
        ConditionExpression: "#value = :token",
        ExpressionAttributeNames: {
          "#value": "value",
        },
        ExpressionAttributeValues: {
          ":token": { S: token },
        },
      });

      return true;
    } catch (error) {
      if (isNamedDynamoDBError(error, "ConditionalCheckFailedException")) {
        return false;
      }

      throw error;
    }
  }

  public extend = async (key: string, token: string, ttlSeconds: number) => {
    await this.ready();

    const now = Date.now();
    const expiredAt = new Date(now + (ttlSeconds * 1000));

    try {
      const result = await this.dynamoDBClient.updateItem({
        TableName: this.tableName,
        Key: {
          key: { S: key },
        },
        UpdateExpression: "SET #expiredAt = :expiredAt",
        ConditionExpression: "#value = :token AND #expiredAt > :now",
        ExpressionAttributeNames: {
          "#value": "value",
          "#expiredAt": "expiredAt",
        },
        ExpressionAttributeValues: {
          ":token": { S: token },
          ":now": { N: String(now) },
          ":expiredAt": { N: String(expiredAt.getTime()) },
        },
        ReturnValues: "UPDATED_NEW",
      });

      return numberAttributeToDate(result.Attributes?.expiredAt) ?? expiredAt;
    } catch (error) {
      if (isNamedDynamoDBError(error, "ConditionalCheckFailedException")) {
        return null;
      }

      throw error;
    }
  }
}
