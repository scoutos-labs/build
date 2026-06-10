import * as Lustre from '../../lustre/lustre.mjs'
import { toList } from '../gleam.mjs'
import * as Option from '../../gleam_stdlib/gleam/option.mjs'
import * as Msg from '../build/msg.mjs'
import * as Project from '../build/actors/project.mjs'
import * as Templates from '../build/pure/templates.mjs'
import * as Chat from '../build/actors/chat.mjs'
import * as WebContainer from '../build/actors/webcontainer.mjs'
import * as Preview from '../build/actors/preview.mjs'
import * as Agent from '../build/actors/agent.mjs'
import * as Settings from '../build/actors/settings.mjs'
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

export function toGleamMessages(messages = []) {
  return toList(messages.map(message => Chat.Message$Message(
    message.role === 'user' ? Chat.Role$User() : Chat.Role$Assistant(),
    message.content,
  )))
}

export function dispatchProjectListRefreshed(projects = []) {
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectListRefreshed(toList(projects.map(p => Project.SavedProject$SavedProject(p.id, p.name, p.updatedAt ?? p.updated_at ?? ''))))))
}

export function dispatchProjectLoaded(project) {
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectLoaded(
    project?.id ? Option.Option$Some(project.id) : Option.Option$None(),
    project?.name ?? 'Untitled Project',
    toGleamFiles(project?.files ?? []),
    project?.selectedPath ?? project?.selected_path ?? '',
    project?.updatedAt ?? project?.updated_at ?? '',
  )))
}

export function dispatchProjectCreated(project) {
  sendMsg(Msg.Msg$Project(Project.Msg$ProjectCreated(
    project.id,
    project.name,
    toGleamFiles(project.files ?? []),
    project.selectedPath ?? project.selected_path ?? 'src/main.tsx',
  )))
}

export function dispatchProjectReady() { sendMsg(Msg.Msg$Project(Project.Msg$ProjectReady())) }
export function dispatchProjectSaveStatus(status) { sendMsg(Msg.Msg$Project(Project.Msg$SaveStatusChanged(status))) }
export function dispatchProjectFilesUpdated(files, status = '') { sendMsg(Msg.Msg$Project(Project.Msg$FilesUpdated(toGleamFiles(files), status))) }
export function dispatchProjectsDialogClosed() { sendMsg(Msg.Msg$Project(Project.Msg$ProjectsDialogClosed())) }

export function dispatchChatMessagesReplaced(messages) { sendMsg(Msg.Msg$Chat(Chat.Msg$MessagesReplaced(toGleamMessages(messages)))) }
export function dispatchChatCleared() { sendMsg(Msg.Msg$Chat(Chat.Msg$ChatCleared())) }
export function dispatchWebContainerRemountRequested(files) { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$RemountRequested(toGleamFiles(files)))) }
export function dispatchWebContainerLog(line) { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$LogAppended(line))) }
export function dispatchWebContainerBootStarted() { sendMsg(Msg.Msg$WebContainer(WebContainer.Msg$BootStarted())) }
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

export function dispatchAgentSucceeded(requestId, reply, patches) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentRequestSucceeded(requestId, reply, toList((patches ?? []).map(p => Agent.Patch$Patch(p.path, p.content)))))) }
export function dispatchAgentFailed(requestId, message) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentRequestFailed(requestId, message))) }
export function dispatchAgentTick(now) { sendMsg(Msg.Msg$Agent(Agent.Msg$AgentElapsedTick(now))) }
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
