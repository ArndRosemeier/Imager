import { createHash } from 'node:crypto';

/**
 * A FAKE ServerStore, implementing the documented contract closely enough to
 * exercise the app's real HTTP path (docs/17 row 42).
 *
 * WHY A FAKE AT THE HTTP LAYER: the app's seam is `fetch`, so stubbing the
 * module would test the stub. This implements the routes, the status codes, the
 * error envelope, the name rule, the `?prefix=` filter, the `x-serverstore-sha256`
 * response header and the 64 MiB body cap — the parts of `docs/API.md` the app
 * depends on — and records every request it answered, so a test can assert what
 * the app ACTUALLY sent.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  status: number;
  /** The object name or route the request addressed. */
  target: string;
}

/**
 * A failure the fake returns for ONE named PUT, so a test can prove the app's
 * per-file failure reporting without breaking the whole batch (docs/17 row 45:
 * one `429` with `Retry-After`, one `413`, …). The code is the service's own
 * stable vocabulary.
 */
export interface FakePutFailure {
  status: number;
  code: string;
  message: string;
  /** Sent as `Retry-After` (whole seconds) when present. */
  retryAfterSeconds?: number;
}

interface StoredObject {
  bytes: Uint8Array;
  sha256: string;
  createdAt: string;
}

export interface FakeStoreOptions {
  store?: string;
  /** The key the fake accepts. Any other key is `401`. */
  key?: string;
  keyId?: string;
  label?: string;
  /** `SERVERSTORE_MAX_BYTES`, for the 413 path. */
  maxBytes?: number;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Realm-safe bytes check (see the PUT branch). */
function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorEnvelope(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export class FakeServerStore {
  readonly requests: RecordedRequest[] = [];
  private readonly objects = new Map<string, StoredObject>();
  private readonly options: Required<FakeStoreOptions>;
  /** Per-object PUT failures, keyed by object name (test lever, not contract). */
  private readonly putFailures = new Map<string, FakePutFailure>();

  constructor(options: FakeStoreOptions = {}) {
    this.options = {
      store: options.store ?? 'imager',
      key: options.key ?? 'ssk_test_KEY',
      keyId: options.keyId ?? 'key-1',
      label: options.label ?? 'alice',
      maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
    };
  }

  /** Put an object straight into the store, bypassing the app (a fixture). */
  seed(name: string, bytes: Uint8Array | string, store = this.options.store): void {
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    this.objects.set(`${store}/${name}`, {
      bytes: data,
      sha256: sha256Hex(data),
      createdAt: new Date(0).toISOString(),
    });
  }

  read(name: string, store = this.options.store): Uint8Array | undefined {
    return this.objects.get(`${store}/${name}`)?.bytes;
  }

  /** Rewrite an object with different bytes: the cache-invalidation lever. */
  replace(name: string, bytes: Uint8Array | string, store = this.options.store): string {
    this.seed(name, bytes, store);
    const entry = this.objects.get(`${store}/${name}`);
    if (entry === undefined) throw new Error('seed failed');
    return entry.sha256;
  }

  remove(name: string, store = this.options.store): void {
    this.objects.delete(`${store}/${name}`);
  }

  names(store = this.options.store): string[] {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${store}/`))
      .map((key) => key.slice(store.length + 1))
      .sort();
  }

  objectCount(store = this.options.store): number {
    return this.names(store).length;
  }

  /** A `fetch` implementation bound to this fake. Synchronous inside; the
   * promise wrapper is what makes it a drop-in for the platform API. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    Promise.resolve(this.handle(input, init));

  private handle(input: RequestInfo | URL, init?: RequestInit): Response {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const auth = new Headers(init?.headers).get('Authorization');
    const record = (status: number, target: string): void => {
      this.requests.push({ method, path, query: url.search, status, target });
    };

    if (path === '/healthz') {
      record(200, '/healthz');
      return json(200, { ok: true });
    }

    const authorized = auth === `Bearer ${this.options.key}`;
    if (!authorized) {
      record(401, path);
      return errorEnvelope(401, 'unauthorized', 'no valid key was presented');
    }

    if (path === '/whoami') {
      record(200, '/whoami');
      return json(200, {
        id: this.options.keyId,
        label: this.options.label,
        stores: [this.options.store],
        perms: ['read', 'write', 'delete'],
        expiresAt: null,
        lastUsedAt: new Date(0).toISOString(),
      });
    }

    const objectsMatch = /^\/stores\/([^/]+)\/objects$/.exec(path);
    if (objectsMatch !== null) {
      const store = objectsMatch[1] ?? '';
      if (store !== this.options.store) {
        record(404, path);
        return errorEnvelope(404, 'not_found', `no store "${store}"`);
      }
      if (method !== 'GET') {
        record(401, path);
        return errorEnvelope(401, 'unauthorized', 'route not found');
      }
      const prefix = url.searchParams.get('prefix');
      if (prefix !== null && !NAME.test(prefix)) {
        record(400, path);
        return errorEnvelope(400, 'invalid_name', `bad prefix "${prefix}"`);
      }
      const objects = this.names(store)
        .filter((name) => prefix === null || name.startsWith(prefix))
        .map((name) => {
          const entry = this.objects.get(`${store}/${name}`);
          return {
            store,
            name,
            sha256: entry?.sha256 ?? '',
            size: entry?.bytes.length ?? 0,
            createdAt: entry?.createdAt ?? new Date(0).toISOString(),
          };
        });
      record(200, path);
      return json(200, { objects });
    }

    const objectMatch = /^\/stores\/([^/]+)\/objects\/(.+)$/.exec(path);
    if (objectMatch !== null) {
      const store = decodeURIComponent(objectMatch[1] ?? '');
      const name = decodeURIComponent(objectMatch[2] ?? '');
      if (store !== this.options.store || !NAME.test(name)) {
        record(400, path);
        return errorEnvelope(400, 'invalid_name', `bad name "${name}"`);
      }
      const key = `${store}/${name}`;
      if (method === 'GET') {
        const entry = this.objects.get(key);
        if (entry === undefined) {
          record(404, path);
          return errorEnvelope(404, 'not_found', `no object "${name}" in store "${store}"`);
        }
        record(200, name);
        return new Response(new Uint8Array(entry.bytes), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'x-serverstore-sha256': entry.sha256,
          },
        });
      }
      if (method === 'PUT') {
        const failure = this.putFailures.get(name);
        if (failure !== undefined) {
          this.putFailures.delete(name);
          record(failure.status, name);
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (failure.retryAfterSeconds !== undefined) {
            headers['Retry-After'] = String(failure.retryAfterSeconds);
          }
          return new Response(
            JSON.stringify({ error: { code: failure.code, message: failure.message } }),
            { status: failure.status, headers },
          );
        }
        const body = init?.body;
        // Realm-safe tag check: `instanceof` is unreliable across the
        // environments a test double meets (the app's own schemas use the same
        // tag check for exactly this reason).
        const bytes = isBytes(body)
          ? body
          : typeof body === 'string'
            ? new TextEncoder().encode(body)
            : new Uint8Array(0);
        if (bytes.length === 0) {
          record(400, name);
          return errorEnvelope(400, 'invalid_body', 'a PUT never creates an empty object');
        }
        if (bytes.length > this.options.maxBytes) {
          record(413, name);
          return errorEnvelope(
            413,
            'payload_too_large',
            `body exceeded ${String(this.options.maxBytes)} bytes`,
          );
        }
        const digest = sha256Hex(bytes);
        this.objects.set(key, {
          bytes,
          sha256: digest,
          createdAt: new Date().toISOString(),
        });
        record(201, name);
        return json(201, {
          store,
          name,
          sha256: digest,
          size: bytes.length,
          createdAt: new Date().toISOString(),
        });
      }
      if (method === 'DELETE') {
        if (!this.objects.has(key)) {
          record(404, path);
          return errorEnvelope(404, 'not_found', `no object "${name}"`);
        }
        this.objects.delete(key);
        record(204, name);
        return new Response(null, { status: 204 });
      }
    }

    record(404, path);
    return errorEnvelope(404, 'not_found', `no route ${method} ${path}`);
  };

  /** Change the body cap (the app's writes have different sizes; a test can
   * let the folder record through and then refuse the image). */
  setMaxBytes(bytes: number): void {
    this.options.maxBytes = bytes;
  }

  /**
   * Refuse the NEXT `PUT` to this name with the service's own error envelope,
   * ONE-SHOT: the entry is consumed by the first matching request, so a later
   * retry of the same name (the next image in the batch legitimately takes a
   * freed sequence) can succeed. That is what makes "one failure does not abort
   * the batch" provable against a specific object.
   */
  failNextPut(name: string, failure: FakePutFailure): void {
    this.putFailures.set(name, failure);
  }

  /** Install this fake as `globalThis.fetch`. */
  install(): void {
    globalThis.fetch = this.fetch;
  }
}
