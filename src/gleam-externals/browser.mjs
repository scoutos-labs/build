import { dispatchNewProjectConfirmed, dispatchRemoveProjectConfirmed } from './runtime_bridge.mjs'

export function confirmNewProject() {
  // Auto-create new project — existing project auto-saves before switch
  dispatchNewProjectConfirmed()
}

let removeProjectPending = false

export function confirmRemoveProject(id) {
  if (removeProjectPending) return
  removeProjectPending = true
  try {
    if (window.confirm('Delete this project? This cannot be undone.')) {
      dispatchRemoveProjectConfirmed(id)
    }
  } finally {
    removeProjectPending = false
  }
}
