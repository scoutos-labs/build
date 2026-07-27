import * as Lustre from '../../lustre/lustre.mjs'
import { toList } from '../gleam.mjs'
import * as Option from '../../gleam_stdlib/gleam/option.mjs'
import * as Msg from '../build/msg.mjs'
import * as Project from '../build/actors/project.mjs'
import * as BuildLog from '../build/pure/build_log.mjs'
import * as Templates from '../build/pure/templates.mjs'
import * as Chat from '../build/actors/chat.mjs'
import * as WebContainer from '../build/actors/webcontainer.mjs'
import * as Preview from '../build/actors/preview.mjs'
import * as Agent from '../build/actors/agent.mjs'
import * as Settings from '../build/actors/settings.mjs'
import * as Publish from '../build/actors/publish.mjs'
import * as PreviewInspector from '../build/pure/preview_inspector.mjs'

let runtime = null

export function registerRuntime(nextRuntime) {
  runtime = nextRuntime
  globalThis.__buildGleamRuntime = nextRuntime
}

export function sendMsg(message) {
  const targetRuntime = runtime ?? globalThis.__buildGleamRuntime
  if (!targetRuntime) return
  targetRuntime.send(Lustre.dispatch(message))
}

export function toGleamFiles(files = []) {
  return toList(files.map(file => Templates.ProjectFile$ProjectFile(file.path, file.content)))
}

export function toGleamBuildLog(entries = []) {
  return toList(entries.map(entry => BuildLog.Entry$Entry(
    entry.at ?? 0,
    entry.prompt ?? '',
    entry.reply ?? '',
    toList(entry.paths ?? []),
  )))
}

export function toGleamMessages(messages = []) {
  return toList(messages.map(message => Chat.Message$Message(
    message.role === 'user' ? Chat.Role$User() : Chat.Role$Assistant(),
    message.content,
    toList(message.paths ?? []),
  )))
}

export function dispatchProjectListRefreshed(projects = []) {
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectListRefreshed(toList(projects.map(p => Project.SavedProject$SavedProject(p.id, p.name, p.updatedAt ?? p.updated_at ?? ''))))))
}

/** Seed the agent's file snapshot whenever a whole file set arrives.
 *
 * Without this the snapshot is empty until the first autosave, so an agent turn
 * on a freshly-opened project would see no files at all. Sourced from the same
 * payload the model is about to receive, so the two cannot disagree. */
async function seedProjectFiles(files) {
  const { publishProjectFiles } = await import('./projects.mjs')
  publishProjectFiles(toGleamFiles(files ?? []))
}

export function dispatchProjectLoaded(project) {
  void seedProjectFiles(project?.files ?? [])
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectLoaded(
    project?.id ? Option.Option$Some(project.id) : Option.Option$None(),
    project?.name ?? 'Untitled Project',
    toGleamFiles(project?.files ?? []),
    project?.selectedPath ?? project?.selected_path ?? '',
    project?.updatedAt ?? project?.updated_at ?? '',
    toGleamBuildLog(project?.buildLog ?? project?.build_log ?? []),
  )))
}

export function dispatchProjectCreated(project) {
  void seedProjectFiles(project.files ?? [])
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectCreated(
    project.id,
    project.name,
    toGleamFiles(project.files ?? []),
    project.selectedPath ?? project.selected_path ?? 'src/main.tsx',
  )))
}

export function dispatchProjectReady() { sendMsg(Msg.Msg$Project(Project.Msg$ProjectReady())) }
export function dispatchProjectSaveStatus(status) { sendMsg(Msg.Msg$Project(Project.Msg$SaveStatusChanged(status))) }
export function dispatchProjectFilesUpdated(files, status = '') { void seedProjectFiles(files); sendMsg(Msg.Msg$Project(Project.Msg$FilesUpdated(toGleamFiles(files), status))) }
export function dispatchProjectsDialogClosed() { sendMsg(Msg.Msg$Project(Project.Msg$ProjectsDialogClosed())) }

export function dispatchChatMessagesReplaced(messages) { sendMsg(Msg.Msg$Chat(Chat.Msg$MessagesReplaced(toGleamMessages(messages)))) }
export function dispatchChatCleared() { sendMsg(Msg.Msg$Chat(Chat.Msg$ChatCleared())) }
export function dispatchWebContainerRemountRequested(files) { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$RemountRequested(toGleamFiles(files)))) }
export function dispatchWebContainerLog(line) { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$LogAppended(line))) }
export function dispatchWebContainerBootStarted() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$BootStarted())) }
export function dispatchWebContainerInstalling() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$PhaseChanged(WebContainer.BootPhase$Installing()))) }
export function dispatchWebContainerStartingDevServer() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$PhaseChanged(WebContainer.BootPhase$StartingDevServer()))) }
export function dispatchWebContainerBootSucceeded() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$BootSucceeded())) }
export function dispatchWebContainerBootFailed(message) { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$BootFailed(message))) }
export function dispatchWebContainerRemountFinished() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$RemountFinished())) }
export function dispatchPreviewUrlChanged(url) { sendMsg(Msg.Msg$Preview(Preview.Msg$PreviewUrlChanged(url))) }

export function dispatchPreviewElementSelected(element) {
  const rect = element.boundingRect ?? {}
  const styles = Object.entries(element.computedStyles ?? {})
  sendMsg(Msg.Msg$Preview(Preview.Msg$ElementSelected(PreviewInspector.SelectedPreviewElement$SelectedPreviewElement(
    element.tagName ?? '',
    element.id ?? '',
    toList(element.classes ?? []),
    element.textContent ?? '',
    element.outerHTML ?? '',
    PreviewInspector.BoundingRect$BoundingRect(Number(rect.x ?? 0), Number(rect.y ?? 0), Number(rect.width ?? 0), Number(rect.height ?? 0)),
    toList(styles),
  ))))
}

export function dispatchAgentFailed(requestId, message) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentRequestFailed(requestId, message))) }
export function dispatchAgentBudgetExhausted(requestId, resetAt) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentBudgetExhausted(requestId, String(resetAt ?? '')))) }
export function dispatchAccountLoaded(plan, budget) { sendMsg(Msg.Msg$Settings(Settings.Msg$AccountLoaded(String(plan ?? ''), String(budget ?? '')))) }
export function dispatchAgentTick(now) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentElapsedTick(now))) }

// ── Agent harness ────────────────────────────────────────────────────────────

// The ONLY legal way for an agent tool to write a project file.
//
// project.files is the source of truth; the WebContainer FS is a replica that
// feeds nothing else. FileApplied updates state.files AND emits
// WriteFileToContainer, so both stay in step. Writing straight to wc.fs would
// leave the editor, the ZIP export, publish, autosave, and the next turn's
// prompt context all reading stale bytes.
export function dispatchProjectFileApplied(path, content) {
  sendMsg(Msg.Msg$Project(Project.Msg$FileApplied(String(path), String(content))))
}

function toGleamToolCalls(calls = []) {
  return toList(calls.map(call => Agent.ToolCall$ToolCall(
    String(call.id ?? ''),
    String(call.name ?? ''),
    String(call.argsJson ?? '{}'),
  )))
}

export function dispatchAgentStepReturned(requestId, toolCalls = [], assistantContent = '') {
  sendMsg(Msg.Msg$Agent(Agent.Msg$AgentStepReturned(
    String(requestId),
    toGleamToolCalls(toolCalls),
    String(assistantContent ?? ''),
  )))
}

export function dispatchAgentToolStarted(requestId, callId, summary) {
  sendMsg(Msg.Msg$Agent(Agent.Msg$AgentToolStarted(String(requestId), String(callId), String(summary ?? ''))))
}

export function dispatchAgentToolFinished(requestId, callId, ok, summary, paths = [], installed = false) {
  sendMsg(Msg.Msg$Agent(Agent.Msg$AgentToolFinished(
    String(requestId),
    String(callId),
    ok ? Agent.ToolStatus$ToolDone() : Agent.ToolStatus$ToolFailed(),
    String(summary ?? ''),
    toList((paths ?? []).map(String)),
    Boolean(installed),
  )))
}

export function dispatchAgentStepBudgetReached(requestId) {
  sendMsg(Msg.Msg$Agent(Agent.Msg$AgentStepBudgetReached(String(requestId))))
}

export function dispatchAgentTimeoutReached(requestId) {
  sendMsg(Msg.Msg$Agent(Agent.Msg$AgentTimeoutReached(String(requestId))))
}
export function dispatchLandingIdea(idea) { sendMsg(Msg.Msg$LandingIdeaArrived(String(idea ?? ''))) }
export function dispatchBuildFromPlan(planSummary) {
  const requestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`
  sendMsg(Msg.Msg$BuildFromPlan(String(planSummary ?? ''), requestId, Date.now()))
}
export function dispatchNewProjectConfirmed() { sendMsg(Msg.Msg$NewProjectConfirmed()) }
export function dispatchRemoveProjectConfirmed(id) { sendMsg(Msg.Msg$RemoveProjectConfirmed(id)) }
export function dispatchSettingsLoaded(settings) {
  sendMsg(Msg.Msg$Settings(Settings.Msg$SettingsLoaded(
    settings.provider ?? 'openrouter',
    settings.apiKey ?? settings.api_key ?? '',
    settings.ollamaUrl ?? settings.ollama_url ?? 'http://localhost:11434',
    settings.model ?? '',
  )))
}
export function dispatchSettingsStatus(status) { sendMsg(Msg.Msg$Settings(Settings.Msg$ConnectionStatusChanged(status))) }

export function dispatchPublishKeyStatusLoaded(saved) { sendMsg(Msg.Msg$Publish(Publish.Msg$KeyStatusLoaded(Boolean(saved)))) }
export function dispatchPublishKeySaved() { sendMsg(Msg.Msg$Publish(Publish.Msg$KeySaved())) }
export function dispatchPublishKeySaveFailed(message) { sendMsg(Msg.Msg$Publish(Publish.Msg$KeySaveFailed(String(message ?? '')))) }
export function dispatchPublishKeyDeleted() { sendMsg(Msg.Msg$Publish(Publish.Msg$KeyDeleted())) }
export function dispatchPublishDeploymentLoaded(projectId, found, subdomain) { sendMsg(Msg.Msg$Publish(Publish.Msg$DeploymentLoaded(String(projectId), Boolean(found), String(subdomain ?? '')))) }
export function dispatchPublishAccepted(buildId, subdomain) { sendMsg(Msg.Msg$Publish(Publish.Msg$PublishAccepted(String(buildId), String(subdomain ?? '')))) }
export function dispatchPublishRejected(code, message) { sendMsg(Msg.Msg$Publish(Publish.Msg$PublishRejected(String(code ?? ''), String(message ?? '')))) }
export function dispatchPublishPollDue(buildId) { sendMsg(Msg.Msg$Publish(Publish.Msg$PollDue(String(buildId)))) }
export function dispatchPublishStatusPolled(buildId, status, url, errorMessage, logs) { sendMsg(Msg.Msg$Publish(Publish.Msg$StatusPolled(String(buildId), String(status ?? ''), String(url ?? ''), String(errorMessage ?? ''), String(logs ?? '')))) }
