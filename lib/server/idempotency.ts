import "server-only";

import { createHash } from "node:crypto";
import type postgres from "postgres";
import { getDatabase } from "../db/postgres.ts";
import { ApiProblem } from "./errors.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export type StoredHttpResult<T extends JsonValue = JsonValue> = {
  status: number;
  body: T;
};

export type IdempotentResult<T extends JsonValue = JsonValue> = StoredHttpResult<T> & {
  replayed: boolean;
};

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

export function hashRequestBody(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

type IdempotencyRow = {
  requestHash: string;
  responseStatus: number | null;
  responseBody: JsonValue | null;
  expiresAt: Date;
};

async function selectRecord(
  tx: postgres.TransactionSql,
  input: IdempotencyInput,
): Promise<IdempotencyRow | null> {
  const rows = await tx<IdempotencyRow[]>`
    SELECT
      request_hash AS "requestHash",
      response_status AS "responseStatus",
      response_body AS "responseBody",
      expires_at AS "expiresAt"
    FROM idempotency_records
    WHERE auth_user_id = ${input.authUserId}::uuid
      AND method = ${input.method}
      AND path = ${input.path}
      AND idempotency_key = ${input.idempotencyKey}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export type IdempotencyInput = {
  authUserId: string;
  method: string;
  path: string;
  idempotencyKey: string;
  body: JsonValue;
};

export async function runIdempotent<T extends JsonValue>(
  input: IdempotencyInput,
  handler: (tx: postgres.TransactionSql) => Promise<StoredHttpResult<T>>,
): Promise<IdempotentResult<T>> {
  const database = getDatabase();
  const requestHash = hashRequestBody(input.body);
  return database.begin(async (tx) => {
    let existing = await selectRecord(tx, input);
    if (existing && existing.expiresAt <= new Date()) {
      await tx`
        DELETE FROM idempotency_records
        WHERE auth_user_id = ${input.authUserId}::uuid
          AND method = ${input.method}
          AND path = ${input.path}
          AND idempotency_key = ${input.idempotencyKey}::uuid
      `;
      existing = null;
    }
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiProblem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "The idempotency key was already used with a different request.",
        });
      }
      if (existing.responseStatus === null || existing.responseBody === null) {
        throw new ApiProblem({
          status: 409,
          code: "IDEMPOTENCY_IN_PROGRESS",
          message: "The original request is still being processed.",
          retryable: true,
          retryAfterMs: 500,
        });
      }
      return {
        status: existing.responseStatus,
        body: existing.responseBody as T,
        replayed: true,
      };
    }

    const inserted = await tx`
      INSERT INTO idempotency_records (
        auth_user_id, method, path, idempotency_key, request_hash
      ) VALUES (
        ${input.authUserId}::uuid,
        ${input.method},
        ${input.path},
        ${input.idempotencyKey}::uuid,
        ${requestHash}
      )
      ON CONFLICT DO NOTHING
    `;
    if (inserted.count === 0) {
      existing = await selectRecord(tx, input);
      if (!existing || existing.requestHash !== requestHash) {
        throw new ApiProblem({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "The idempotency key was already used with a different request.",
        });
      }
      if (existing.responseStatus === null || existing.responseBody === null) {
        throw new ApiProblem({
          status: 409,
          code: "IDEMPOTENCY_IN_PROGRESS",
          message: "The original request is still being processed.",
          retryable: true,
          retryAfterMs: 500,
        });
      }
      return {
        status: existing.responseStatus,
        body: existing.responseBody as T,
        replayed: true,
      };
    }

    const result = await handler(tx);
    await tx`
      UPDATE idempotency_records
      SET response_status = ${result.status}, response_body = ${tx.json(result.body)}
      WHERE auth_user_id = ${input.authUserId}::uuid
        AND method = ${input.method}
        AND path = ${input.path}
        AND idempotency_key = ${input.idempotencyKey}::uuid
    `;
    return { ...result, replayed: false };
  });
}
