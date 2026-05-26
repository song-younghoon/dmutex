# dmutex

MongoDB를 백엔드로 사용하는 간단한 TypeScript 분산 mutex 라이브러리입니다.

`Mutex.acquire()`는 MongoDB 컬렉션의 `_id` 유니크 제약을 이용해 같은 키에 대해 한 번에 하나의 호출만 성공하게 만들고, TTL 인덱스로 오래 남은 락 문서를 자동 만료시킵니다. 각 락에는 소유권 토큰이 저장되어 오래된 작업자가 새 작업자의 락을 해제하지 못하게 합니다.

## 설치

```bash
bun add dmutex
```

`dmutex`는 특정 MongoDB Node.js 드라이버 버전을 dependency 또는 peer dependency로 강제하지 않습니다. 애플리케이션에서 이미 사용 중인 MongoDB 클라이언트를 넘겨 사용하세요.

공식 `mongodb` 패키지를 사용하는 경우에는 애플리케이션 쪽에서 원하는 버전을 설치하면 됩니다.

```bash
bun add mongodb
```

## 사용 예시

```ts
import { MongoClient } from "mongodb";
import { Mutex } from "dmutex";

const mongoClient = new MongoClient("mongodb://localhost:27017");
await mongoClient.connect();

const mutex = new Mutex("my-service", mongoClient);
await mutex.ready();

const lock = await mutex.acquire("job:daily-report", 60);

if (!lock) {
  // 다른 프로세스가 이미 같은 키의 락을 보유 중입니다.
  process.exit(0);
}

try {
  // 보호해야 하는 작업을 실행합니다.
} finally {
  await lock.release();
  await mongoClient.close();
}
```

## API

### `new Mutex(serviceName, mongoClient, options?)`

서비스별 mutex 인스턴스를 생성합니다.

- `serviceName`: MongoDB 컬렉션 이름에 사용되는 서비스 식별자
- `mongoClient`: `db(name).collection(name)` 형태의 MongoDB 클라이언트. 공식 `mongodb` 패키지의 `MongoClient`를 그대로 넘길 수 있습니다.
- `options.dbName`: 사용할 DB 이름. 기본값은 `dmutex`
- `options.collectionName`: 사용할 컬렉션 이름. 지정하면 prefix/serviceName 조합보다 우선합니다.
- `options.collectionPrefix`: 컬렉션 prefix. 기본값은 `_dmutex_`
- `options.defaultTtlSeconds`: 기본 락 만료 시간. 기본값은 300초

내부적으로 `dmutex` 데이터베이스의 `_dmutex_${serviceName}` 컬렉션을 사용합니다.

### `ready()`

```ts
await mutex.ready();
```

TTL 인덱스 생성이 완료될 때까지 기다립니다. `acquire()`, `lock()`, `unlock()`, `extend()`도 내부적으로 `ready()`를 기다리지만, 애플리케이션 시작 시 명시적으로 호출하면 초기화 실패를 더 빨리 확인할 수 있습니다.

### `acquire(key, ttl?)`

```ts
const lock = await mutex.acquire("some-key", 300);

if (lock) {
  try {
    // protected work
  } finally {
    await lock.release();
  }
}
```

지정한 키의 락 획득을 시도합니다.

- `key`: 락을 식별하는 문자열
- `ttl`: 락 만료 시간(초). 기본값은 300초입니다.
- 반환값: 락 획득에 성공하면 `MutexLock`, 이미 같은 키가 잠겨 있으면 `null`

`MutexLock`은 다음 필드를 제공합니다.

- `key`: 락 키
- `token`: 락 소유권 토큰
- `expiredAt`: 현재 락 만료 시각
- `release()`: 현재 토큰과 일치하는 락만 해제합니다.
- `extend(ttl?)`: 현재 토큰과 일치하고 아직 만료되지 않은 락만 연장합니다.

### `lock(key, ttl?)`

```ts
const acquired = await mutex.lock("some-key", 300);
```

지정한 키의 락 획득을 시도합니다.

- `key`: 락을 식별하는 문자열
- `ttl`: 락 만료 시간(초). 기본값은 300초입니다.
- 반환값: 락 획득에 성공하면 `true`, 이미 같은 키가 잠겨 있으면 `false`

기존 boolean 스타일 API입니다. 새 코드에서는 소유권을 명시적으로 다룰 수 있는 `acquire()` 사용을 권장합니다.

### `unlock(key, token?)`

```ts
await mutex.unlock("some-key");
```

지정한 키의 락 문서를 삭제합니다. `token`을 넘기면 해당 토큰과 일치하는 락만 삭제합니다. `lock()`으로 획득한 락은 같은 `Mutex` 인스턴스에서 내부 토큰을 기억하므로 `unlock(key)`로 해제할 수 있습니다.

### `extend(key, token, ttl?)`

```ts
await mutex.extend("some-key", lock.token, 300);
```

현재 토큰과 일치하고 아직 만료되지 않은 락의 TTL을 연장합니다. 성공하면 `true`, 소유자가 다르거나 이미 만료되었으면 `false`를 반환합니다.

## 동작 방식과 주의사항

- 락 획득은 MongoDB `insertOne()`으로 수행됩니다. 같은 `_id`를 가진 문서는 하나만 존재할 수 있으므로 동시 호출 중 하나만 성공합니다.
- TTL은 `expiredAt` 필드와 MongoDB TTL 인덱스로 처리됩니다. MongoDB TTL 모니터는 주기적으로 동작하므로 만료된 락이 정확히 만료 시각에 즉시 삭제된다고 가정하면 안 됩니다.
- 이미 만료된 락 문서가 TTL 모니터에 의해 아직 삭제되지 않았더라도, 새 락 획득 시도는 만료 여부를 확인하고 원자적으로 takeover를 시도합니다.
- 락 해제와 연장은 소유권 토큰을 검증합니다. 가장 안전한 사용 방식은 `acquire()`가 반환한 lock handle의 `release()`/`extend()`를 호출하는 것입니다.
- 생성자는 TTL 인덱스 생성을 요청합니다. 운영 환경에서는 애플리케이션 시작 시 mutex 인스턴스를 미리 생성하고 `ready()`를 호출하는 것을 권장합니다.
- duplicate key 충돌은 정상적인 락 경합으로 처리되지만, 연결 장애나 권한 오류 같은 MongoDB 오류는 호출자에게 throw됩니다.
- 패키지는 런타임에서 `mongodb`를 import하지 않습니다. 필요한 클라이언트 표면은 `db`, `collection`, `createIndex`, `insertOne`, `updateOne`, `deleteOne`입니다.

## 개발

의존성 설치:

```bash
bun install
```

빌드:

```bash
bun run build
```

테스트:

```bash
bun test
```

테스트는 MongoDB가 필요합니다. 기본 연결 문자열은 `mongodb://localhost:27017`이며, 다른 주소를 사용하려면 `MONGODB_URL` 환경 변수를 지정하세요.

```bash
MONGODB_URL=mongodb://localhost:27017 bun test
```
