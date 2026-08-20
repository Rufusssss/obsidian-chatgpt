import path from "node:path";

import type { ParsedOutgoingLink } from "./obsidian-metadata.ts";

export type LinkResolution = "resolved" | "missing" | "ambiguous";

export interface ResolvedOutgoingLink extends ParsedOutgoingLink {
  readonly resolution: LinkResolution;
  readonly resolvedPath?: string;
}

function withoutMarkdownExtension(value: string): string {
  return value.toLocaleLowerCase("en-US").endsWith(".md")
    ? value.slice(0, -3)
    : value;
}

function noteIdentity(notePath: string): string {
  return withoutMarkdownExtension(notePath).toLocaleLowerCase("en-US");
}

function linkNoteTarget(target: string): string {
  const fragmentIndex = target.indexOf("#");
  return (fragmentIndex === -1 ? target : target.slice(0, fragmentIndex)).trim();
}

export class VaultLinkResolver {
  readonly #pathsByIdentity = new Map<string, readonly string[]>();
  readonly #pathsByBasename = new Map<string, readonly string[]>();

  constructor(notePaths: readonly string[]) {
    const identityGroups = new Map<string, string[]>();
    const basenameGroups = new Map<string, string[]>();
    for (const notePath of notePaths) {
      const identity = noteIdentity(notePath);
      const basename = path.posix.basename(identity);
      identityGroups.set(identity, [
        ...(identityGroups.get(identity) ?? []),
        notePath,
      ]);
      basenameGroups.set(basename, [
        ...(basenameGroups.get(basename) ?? []),
        notePath,
      ]);
    }
    for (const [key, paths] of identityGroups) {
      this.#pathsByIdentity.set(key, Object.freeze(paths.toSorted()));
    }
    for (const [key, paths] of basenameGroups) {
      this.#pathsByBasename.set(key, Object.freeze(paths.toSorted()));
    }
  }

  resolve(sourcePath: string, link: ParsedOutgoingLink): ResolvedOutgoingLink {
    const target = linkNoteTarget(link.target);
    if (target.length === 0 || target.startsWith("^")) {
      return Object.freeze({
        ...link,
        resolution: "resolved",
        resolvedPath: sourcePath,
      });
    }

    if (
      target.startsWith("/") ||
      target.includes("\\") ||
      target.includes(":") ||
      target.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return Object.freeze({ ...link, resolution: "missing" });
    }

    const normalizedTarget = withoutMarkdownExtension(target).toLocaleLowerCase(
      "en-US",
    );
    const candidates = target.includes("/")
      ? this.#pathsByIdentity.get(normalizedTarget) ?? []
      : this.#pathsByBasename.get(path.posix.basename(normalizedTarget)) ?? [];
    const onlyCandidate = candidates.length === 1 ? candidates[0] : undefined;
    if (onlyCandidate !== undefined) {
      return Object.freeze({
        ...link,
        resolution: "resolved",
        resolvedPath: onlyCandidate,
      });
    }
    if (candidates.length === 0) {
      return Object.freeze({ ...link, resolution: "missing" });
    }

    if (!target.includes("/")) {
      const sourceFolder = path.posix.dirname(sourcePath);
      const localCandidates = candidates.filter(
        (candidate) => path.posix.dirname(candidate) === sourceFolder,
      );
      const onlyLocalCandidate =
        localCandidates.length === 1 ? localCandidates[0] : undefined;
      if (onlyLocalCandidate !== undefined) {
        return Object.freeze({
          ...link,
          resolution: "resolved",
          resolvedPath: onlyLocalCandidate,
        });
      }
    }

    return Object.freeze({ ...link, resolution: "ambiguous" });
  }
}
