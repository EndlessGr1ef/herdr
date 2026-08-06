import { beforeEach, expect, mock, test } from "bun:test";

const requests: unknown[] = [];
const clients: FakeClient[] = [];
const requestWaiters: Array<() => void> = [];
let autoAcknowledge = true;
let importCounter = 0;

type FakeClient = {
  emit: (event: string) => void;
};

mock.module("node:net", () => ({
  default: {
    createConnection(_path: string, onConnect: () => void) {
      const handlers = new Map<string, () => void>();
      const client = {
        write(input: string) {
          requests.push(JSON.parse(input.trim()));
          requestWaiters.shift()?.();
          if (autoAcknowledge) {
            queueMicrotask(() => client.emit("data"));
          }
        },
        setTimeout() {},
        on(event: string, handler: () => void) {
          handlers.set(event, handler);
        },
        destroy() {},
        emit(event: string) {
          handlers.get(event)?.();
        },
      };
      clients.push(client);
      queueMicrotask(onConnect);
      return client;
    },
  },
}));

beforeEach(() => {
  requests.length = 0;
  clients.length = 0;
  requestWaiters.length = 0;
  autoAcknowledge = true;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "test.sock";
  process.env.HERDR_PANE_ID = "test:p1";
});

async function loadPlugin() {
  importCounter += 1;
  const { HerdrAgentStatePlugin } = await import(`./herdr-agent-state.js?test=${importCounter}`);
  return HerdrAgentStatePlugin();
}

function waitForNextRequest(): Promise<void> {
  return new Promise((resolve) => requestWaiters.push(resolve));
}

test("serializes lifecycle reports", async () => {
  autoAcknowledge = false;
  const plugin = await loadPlugin();
  const firstDispatched = waitForNextRequest();
  const working = plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    },
  });
  await firstDispatched;

  const secondDispatched = waitForNextRequest();
  const idle = plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "idle" } },
    },
  });
  expect(clients).toHaveLength(1);

  clients[0]?.emit("data");
  await secondDispatched;
  expect(clients).toHaveLength(2);
  clients[1]?.emit("data");
  await Promise.all([working, idle]);

  expect(requests.map(requestState)).toEqual(["working", "idle"]);
  const sequences = requests.map(requestSeq);
  expect(sequences[0]).toEqual(expect.any(Number));
  expect(sequences[1]).toBe((sequences[0] as number) + 1);
});

test("reports title from session.updated on continue — first event adopts root session", async () => {
  const plugin = await loadPlugin();

  // When continuing an existing session (no session.created), the first
  // non-subagent session.updated with a sessionID should adopt it as the
  // current root session and forward its non-default title.
  await plugin.event({
    event: {
      type: "session.updated",
      properties: { sessionID: "continued-session", info: { title: "My Project Work" } },
    },
  });

  expect(requests.map(requestMethod)).toEqual([
    "pane.report_agent_session",
    "pane.report_metadata",
  ]);
  expect(requests.map(requestSessionID)).toEqual(["continued-session", undefined]);
  expect(requests.map((r) => requestParam(r, "title"))).toEqual([undefined, "My Project Work"]);
});

test("suppresses broadcast session.updated for different session after root is established", async () => {
  const plugin = await loadPlugin();

  // Establish root via session.created (new session flow).
  await plugin.event({
    event: { type: "session.created", properties: { sessionID: "root-session", info: { title: "Root Session" } } },
  });
  requests.length = 0; // discard establishment requests

  // A session.updated for the root is forwarded.
  await plugin.event({
    event: { type: "session.updated", properties: { sessionID: "root-session", info: { title: "Root Session" } } },
  });

  // A broadcast session.updated for a different session is suppressed —
  // opencode emits these for ALL sessions in the directory, so adopting would
  // clobber the tab name with a previous session's title.
  await plugin.event({
    event: { type: "session.updated", properties: { sessionID: "replacement-session", info: { title: "Replacement" } } },
  });

  // Only the root session update should produce output.
  expect(requests.map(requestMethod)).toEqual(["pane.report_agent_session", "pane.report_metadata"]);
  expect(requests.map(requestSessionID)).toEqual(["root-session", undefined]);
  expect(requests.map((r) => requestParam(r, "title"))).toEqual([undefined, "Root Session"]);
});

test("reports retry status as working", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "retry" } },
    },
  });

  expect(requests.map(requestMethod)).toEqual(["pane.report_agent"]);
  expect(requests.map(requestState)).toEqual(["working"]);
  expect(requests.map(requestSessionID)).toEqual(["root-session"]);
});

test("reports child prompts without replacing the root session", async () => {
  const plugin = await loadPlugin();

  await plugin.event({
    event: {
      type: "session.created",
      properties: {
        sessionID: "child-session",
        info: { id: "child-session", parentID: "root-session" },
      },
    },
  });

  for (const type of ["permission.asked", "question.asked"]) {
    await plugin.event({ event: { type, properties: { sessionID: "child-session" } } });
  }
  for (const type of ["permission.replied", "question.replied", "question.rejected"]) {
    await plugin.event({ event: { type, properties: { sessionID: "child-session" } } });
  }

  expect(requests.map(requestState)).toEqual([
    "blocked",
    "blocked",
    "working",
    "working",
    "working",
  ]);
  expect(requests.map(requestSessionID)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

function requestMethod(request: unknown): unknown {
  return isRecord(request) ? request.method : undefined;
}

function requestState(request: unknown): unknown {
  return requestParam(request, "state");
}

function requestSeq(request: unknown): unknown {
  return requestParam(request, "seq");
}

function requestSessionID(request: unknown): unknown {
  return requestParam(request, "agent_session_id");
}

function requestParam(request: unknown, name: string): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}