/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MANAGED_AUTH?: string
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string
}

declare module '*.mjs' {
  export function main(): void
  export function registerBuildEditor(): void
  export function registerBuildTerminal(): void
  export function dispatchPreviewElementSelected(element: unknown): void
  export function dispatchBuildFromPlan(planSummary: string): void
  export function dispatchWebContainerLog(line: string): void
}
