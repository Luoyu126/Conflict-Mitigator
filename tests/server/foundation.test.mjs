import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractBearerToken, requireServiceToken } from "../../lib/server/auth.ts";
import { ApiProblem } from "../../lib/server/errors.ts";
import { errorResponse, successResponse } from "../../lib/server/http.ts";
import { hashRequestBody, runIdempotent } from "../../lib/server/idempotency.ts";
import { parseJsonBody, requireIdempotencyKey } from "../../lib/server/validation.ts";
import { closeDatabase } from "../../lib/db/postgres.ts";
import { requireRoomHost, requireRoomMember } from "../../lib/db/repositories/membership.ts";

test("strict JSON parsing returns typed data and safe field issues", async () => {
  const schema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
  const parsed = await parseJsonBody(new Request("http://local.test/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  Planning  " }),
  }), schema);
  assert.deepEqual(parsed, { title: "Planning" });

  await assert.rejects(
    parseJsonBody(new Request("http://local.test/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Planning", unexpected: "private" }),
    }), schema),
    (error) => error instanceof ApiProblem
      && error.status === 422
      && error.code === "VALIDATION_ERROR"
      && error.issues.length === 1,
  );
});

test("response helpers enforce the API envelope and no-store", async () => {
  const success = successResponse({ ok: true }, {
    status: 201,
    requestId: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(success.status, 201);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.deepEqual(await success.json(), {
    data: { ok: true },
    requestId: "00000000-0000-4000-8000-000000000001",
  });

  const failure = errorResponse(new Error("DATABASE_URL=do-not-leak"),
    "00000000-0000-4000-8000-000000000002");
  const failureBody = await failure.json();
  assert.equal(failure.status, 500);
  assert.equal(failureBody.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(failureBody), /DATABASE_URL|do-not-leak/);
});

test("bearer and idempotency headers are strict", () => {
  const request = new Request("http://local.test", {
    headers: {
      authorization: "Bearer local-token",
      "idempotency-key": "00000000-0000-4000-8000-000000000003",
    },
  });
  assert.equal(extractBearerToken(request), "local-token");
  assert.equal(requireIdempotencyKey(request), "00000000-0000-4000-8000-000000000003");
  assert.throws(() => extractBearerToken(new Request("http://local.test")),
    (error) => error instanceof ApiProblem && error.code === "UNAUTHENTICATED");
});

test("service credentials compare without exposing configured values", () => {
  const previous = process.env.WORKER_SERVICE_TOKEN;
  process.env.WORKER_SERVICE_TOKEN = "expected-local-token";
  try {
    requireServiceToken(new Request("http://local.test", {
      headers: { authorization: "Bearer expected-local-token" },
    }), "WORKER_SERVICE_TOKEN");
    assert.throws(() => requireServiceToken(new Request("http://local.test", {
      headers: { authorization: "Bearer wrong-local-token" },
    }), "WORKER_SERVICE_TOKEN"),
    (error) => error instanceof ApiProblem
      && error.code === "UNAUTHENTICATED"
      && !error.message.includes("expected-local-token"));
  } finally {
    if (previous === undefined) delete process.env.WORKER_SERVICE_TOKEN;
    else process.env.WORKER_SERVICE_TOKEN = previous;
  }
});

test("request hashing is stable across object key order", () => {
  assert.equal(
    hashRequestBody({ title: "Planning", nested: { b: 2, a: 1 } }),
    hashRequestBody({ nested: { a: 1, b: 2 }, title: "Planning" }),
  );
});

test("transactional idempotency replays and rejects changed bodies", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const input = {
    authUserId: "00000000-0000-4000-8000-000000000101",
    method: "POST",
    path: "/api/rooms",
    idempotencyKey: randomUUID(),
    body: { title: "Planning" },
  };
  let calls = 0;
  const first = await runIdempotent(input, async () => {
    calls += 1;
    return { status: 201, body: { roomId: "00000000-0000-4000-8000-000000000001" } };
  });
  const replay = await runIdempotent(input, async () => {
    calls += 1;
    return { status: 500, body: { shouldNotRun: true } };
  });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(replay.body, first.body);

  await assert.rejects(
    runIdempotent({ ...input, body: { title: "Different" } }, async () => ({
      status: 201,
      body: { unreachable: true },
    })),
    (error) => error instanceof ApiProblem && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("membership and host authorization use authenticated subject mapping", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { getDatabase } = await import("../../lib/db/postgres.ts");
  const db = getDatabase();
  await db`
    INSERT INTO rooms (id, title, created_by)
    VALUES (
      '00000000-0000-4000-8000-000000000301',
      'Authorization test',
      '00000000-0000-4000-8000-000000000101'
    )
  `;
  await db`
    INSERT INTO participants (
      id, room_id, auth_user_id, display_name, role, livekit_identity
    ) VALUES (
      '00000000-0000-4000-8000-000000000311',
      '00000000-0000-4000-8000-000000000301',
      '00000000-0000-4000-8000-000000000101',
      'Alice',
      'host',
      '00000000-0000-4000-8000-000000000311'
    )
  `;
  try {
    const member = await requireRoomMember(db,
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000101");
    const host = await requireRoomHost(db,
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000101");
    assert.equal(member.id, host.id);
    await assert.rejects(
      requireRoomMember(db,
        "00000000-0000-4000-8000-000000000301",
        "00000000-0000-4000-8000-000000000999"),
      (error) => error instanceof ApiProblem && error.code === "FORBIDDEN",
    );
  } finally {
    await db`DELETE FROM rooms WHERE id = '00000000-0000-4000-8000-000000000301'`;
  }
});

test.after(async () => {
  await closeDatabase();
});
