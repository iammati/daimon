// Types for daimon plugins: editor autocomplete and checking only, nothing here runs.
// Written by `daimon plugin init`, which overwrites it to match the installed daimon.
// Source of truth: ui/src/lib/daimon/plugins.ts (`pluginApi`).

declare module "daimon" {
  import type { ComponentType, ReactNode, createElement } from "react";

  export type ExecResult = { code: number | null; stdout: string; stderr: string };
  type Toast = (message: string, opts?: { description?: string; duration?: number; id?: string }) => string | number;

  /** API version; bumped on breaking changes. */
  export const version: number;
  export const React: typeof import("react");
  export const h: typeof createElement;
  /** JSX-like tagged templates for plain .js plugins: html`<b onClick=${fn}>${x}</b>`. */
  export function html(strings: TemplateStringsArray, ...values: unknown[]): ReactNode;
  /** Put a button/badge into the header's right side. Registering an id again replaces it. */
  export function registerHeaderButton(id: string, render: ComponentType | ReactNode): void;
  /** Run a program (no shell). Rejects on spawn failure or timeout (default 10 s). */
  export function exec(cmd: string, args?: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  /** Persistent key/value strings (shared with daimon's own prefs: prefix your keys). */
  export function prefGet(key: string): Promise<string | null>;
  export function prefSet(key: string, value: string): Promise<boolean>;
  /** daimon's keyboard-hint chips: <Keys combo="⌘⇧T" size="xs" />. */
  export const components: {
    Keys: ComponentType<{ combo: string; size?: "xs" | "sm" | "md"; className?: string }>;
    Kbd: ComponentType<{ children?: ReactNode; size?: "xs" | "sm" | "md"; className?: string }>;
  };
  export const toast: Toast & { success: Toast; error: Toast; warning: Toast; info: Toast; dismiss(id?: string | number): void };

  /** What a default export receives (the same as this module's exports). */
  export type DaimonPluginApi = typeof import("daimon");
  /** Optional default export: may return a cleanup, called before a reload/removal. */
  export type Plugin = (daimon: DaimonPluginApi) => void | (() => void) | Promise<void | (() => void)>;
}

// Minimal React types, enough for plugins without installing @types/react.
// (Delete this block if you install @types/react in this folder.)
declare module "react" {
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export interface ReactElement { type: unknown; props: unknown; key: string | null }
  export type ComponentType<P = {}> = (props: P) => ReactNode;
  export type FC<P = {}> = ComponentType<P>;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface RefObject<T> { current: T }
  export type DependencyList = readonly unknown[];

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useEffect(effect: () => void | (() => void), deps?: DependencyList): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: DependencyList): void;
  export function useRef<T>(initial: T): RefObject<T>;
  export function useMemo<T>(factory: () => T, deps: DependencyList): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: DependencyList): T;
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, Dispatch<A>];
  export function useId(): string;
  export function createElement(type: unknown, props?: unknown, ...children: ReactNode[]): ReactElement;
  export const Fragment: ComponentType<{ children?: ReactNode }>;
}

declare module "react/jsx-runtime" {
  import type { ReactElement } from "react";
  export namespace JSX {
    type Element = ReactElement;
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: string | number | null }
    interface IntrinsicElements { [tag: string]: Record<string, any> }
  }
  export function jsx(type: unknown, props: unknown, key?: string): ReactElement;
  export const jsxs: typeof jsx;
  export const Fragment: unknown;
}
