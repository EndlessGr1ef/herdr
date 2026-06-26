// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=10

import net from "node:net";

const SOURCE = "herdr:opencode";
const AGENT = "opencode";
let reportSeq = Date.now() * 1000;
let requestChain = Promise.resolve();
let reportedRootSessionID;

// Track child sessions so their events cannot replace the pane's root session.
// Their user prompts still project state without attaching the child session id.
const childSessions = new Set();
const CHILD_EVENT_STATES = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

const SESSION_STATE_BY_STATUS = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["pending", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["streaming", "working"],
  ["working", "working"],
]);

function sessionTitleFromProperties(properties) {
  const title = properties?.info?.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function isDefaultSessionTitle(title) {
  return title.startsWith("New session - ") || title.startsWith("Child session - ");
}

// opencode subagent (child) sessions have `parentID` set; root sessions do not.
// Only the root session should drive the tab name — subagent titles must not
// overwrite it.
function isSubagentSession(properties) {
  return properties?.info?.parentID !== undefined;
}

function stateFromSessionStatus(status) {
  const kind = typeof status === "string" ? status : status?.type;
  return typeof kind === "string"
    ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase())
    : undefined;
}

function request(method, params) {
  const pending = requestChain.then(() => requestOnce(method, params));
  requestChain = pending.catch(() => {});
  return pending;
}

function requestOnce(method, params) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;

  if (!paneId || !socketPath) {
    return Promise.resolve();
  }

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  const requestId = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
  const request = {
    id: requestId,
    method,
    params: {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      seq: nextReportSeq(),
      ...params,
    },
  };

  return new Promise((resolve) => {
    const client = net.createConnection(socketEndpoint, () => {
      client.write(`${JSON.stringify(request)}\n`);
    });

    const finish = () => {
      client.destroy();
      resolve();
    };

    client.setTimeout(500, finish);
    client.on("data", finish);
    client.on("error", finish);
    client.on("end", finish);
    client.on("close", resolve);
  });
}

function reportSession(sessionID, sessionStartSource) {
  if (!sessionID) {
    return Promise.resolve();
  }
  const params = { agent_session_id: sessionID };
  if (sessionStartSource) {
    params.session_start_source = sessionStartSource;
  }
  return request("pane.report_agent_session", params);
}

function reportTitle(title) {
  if (!title) {
    return Promise.resolve();
  }
  return request("pane.report_metadata", { title });
}

function clearTitle() {
  return request("pane.report_metadata", { clear_title: true });
}

function reportState(state, sessionID) {
  const params = { state };
  if (sessionID) {
    reportedRootSessionID = sessionID;
    params.agent_session_id = sessionID;
  }
  return request("pane.report_agent", params);
}

export const HerdrAgentStatePlugin = async () => {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_SOCKET_PATH ||
    !process.env.HERDR_PANE_ID
  ) {
    return {};
  }

  // Track the current root session for this opencode process. The plugin
  // receives session.updated events for ALL sessions in the same directory
  // (not just the current one), so we must filter to avoid forwarding a
  // previous session's title to herdr and clobbering the tab name.
  let currentRootSessionID = undefined;

  return {
    "chat.message": async ({ sessionID }) => {
      if (sessionID && childSessions.has(sessionID)) {
        return;
      }
      await reportState("working", sessionID);
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = sessionIDFromProperties(properties);
      const title = sessionTitleFromProperties(properties);

      const info = properties.info;
      if (info?.id && info.parentID) {
        childSessions.add(info.id);
      }
      if (sessionID && childSessions.has(sessionID)) {
        const state = CHILD_EVENT_STATES.get(type);
        if (state) {
          await reportState(state);
        }
        return;
      }

      switch (type) {
        case "session.created":
        case "session.updated":
          if (isSubagentSession(properties)) {
            // subagent session — report for lifecycle tracking, do not rename
            await reportSession(sessionID);
            break;
          }
          // Only session.created establishes the current root session.
          // session.updated must NOT adopt — opencode broadcasts
          // session.updated for ALL sessions in the directory, so adopting
          // from it would pick up a previous session's title.
          if (type === "session.created") {
            currentRootSessionID = sessionID;
            // A root session.created is a genuine new-session start (subagent
            // creates are dropped above). Signal it so herdr replaces the pane's
            // prior session id instead of treating the change as cross-talk.
            await reportSession(sessionID, "new");
          } else {
            // Only report + forward title for the current root session.
            if (sessionID !== currentRootSessionID) {
              break;
            }
            await reportSession(sessionID);
          }
          if (title && !isDefaultSessionTitle(title)) {
            await reportTitle(title);
          } else {
            await clearTitle();
          }
          break;
        case "session.status": {
          const state = stateFromSessionStatus(properties.status);
          if (state) {
            await reportState(state, sessionID);
          } else {
            await reportSession(sessionID);
          }
          break;
        }
        case "tool.execute.before":
        case "tool.execute.after":
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
        case "session.compacted":
          await reportState("working", sessionID);
          break;
        case "permission.asked":
        case "question.asked":
        case "session.error":
          await reportState("blocked", sessionID);
          break;
        case "session.idle":
          await reportState("idle", sessionID);
          break;
        case "session.deleted":
          if (sessionID === currentRootSessionID) {
            currentRootSessionID = undefined;
          }
          break;
        default:
          break;
      }
    },
  };
};
