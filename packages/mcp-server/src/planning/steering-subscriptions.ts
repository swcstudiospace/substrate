/**
 * Per-session steering subscriptions (phase 104, F5 steering injection v2).
 *
 * A subscription selects which steering-worthy events reach one live session's
 * TODO inbox. Default-off: an absent record (or `optedIn: false`) means no
 * injection, so a session hears nothing until it explicitly opts in.
 *
 * Matching is pure ({@link matchesSubscription}): the event kind must be in
 * the session's allow-list AND every configured scope must match. Scopes are
 * optional glob prefixes (`*` matches anything, otherwise a path prefix):
 * - `pathScope`: matched against the event's `path` (repo-relative file path).
 * - `graphScope`: matched against the event's `graph` (relationship-graph node).
 * No scope configured matches any event of an allowed kind.
 *
 * Safety (phase 104 addendum): subscriptions are the consent gate — injection
 * only proposes (queues a directive, never acknowledges), bodies are size
 * capped and redacted at the injector, and self-triggering steer events
 * (`steering.queued`, kind prefix `steering.`) never match.
 */
import { SESSION_ID_RE } from "./presence.ts";

/** A steering-worthy event as the injector sees it (phase 102 `planning.changed` shape, narrowed). */
export interface SteeringSourceEvent {
	id: string;
	kind: string;
	occurredAtMs: number;
	seq: number;
	repo?: string | undefined;
	path?: string | undefined;
	graph?: string | undefined;
	summary?: string | undefined;
}

/** One session's injection filter. Absent record (or optedIn false) = no injection. */
export interface SteeringSubscription {
	sessionId: string;
	eventKinds: string[];
	pathScope?: string | undefined;
	graphScope?: string | undefined;
	optedIn: boolean;
}

/** Events the loop guard always drops: steering's own wake-ups must not re-steer. */
const SELF_TRIGGER_PREFIX = "steering.";

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) throw new RangeError("invalid session id");
}

/** Glob-prefix match: `*` matches all, `prefix*` matches the prefix, else exact/prefix match. */
function scopeMatches(scope: string | undefined, value: string | undefined): boolean {
	if (scope === undefined || scope === "") return true;
	if (scope === "*") return true;
	const candidate = value ?? "";
	if (scope.endsWith("*")) return candidate.startsWith(scope.slice(0, -1));
	return candidate === scope || candidate.startsWith(scope.endsWith("/") ? scope : `${scope}/`);
}

/** Pure filter: kind allow-list AND scope match. Never throws for a well-formed subscription. */
export function matchesSubscription(sub: SteeringSubscription, event: SteeringSourceEvent): boolean {
	if (!sub.optedIn) return false;
	if (event.kind.startsWith(SELF_TRIGGER_PREFIX)) return false;
	if (!sub.eventKinds.includes(event.kind)) return false;
	return scopeMatches(sub.pathScope, event.path) && scopeMatches(sub.graphScope, event.graph);
}

/** In-memory per-session subscription registry. Process-local like the inbox. */
export class SteeringSubscriptions {
	private readonly subs = new Map<string, SteeringSubscription>();

	/** Opts a session in (or replaces its filter). Throws on a malformed session id. */
	subscribe(input: { sessionId: string; eventKinds: string[]; pathScope?: string; graphScope?: string }): SteeringSubscription {
		assertSessionId(input.sessionId);
		if (input.eventKinds.length === 0) throw new RangeError("eventKinds must not be empty");
		const sub: SteeringSubscription = {
			sessionId: input.sessionId,
			eventKinds: [...input.eventKinds],
			...(input.pathScope === undefined ? {} : { pathScope: input.pathScope }),
			...(input.graphScope === undefined ? {} : { graphScope: input.graphScope }),
			optedIn: true,
		};
		this.subs.set(input.sessionId, structuredClone(sub));
		return structuredClone(sub);
	}

	/** Opts a session out. Absent session is a no-op returning false. */
	unsubscribe(sessionId: string): boolean {
		assertSessionId(sessionId);
		return this.subs.delete(sessionId);
	}

	/** A copy of one session's subscription, or null when absent. */
	get(sessionId: string): SteeringSubscription | null {
		const sub = this.subs.get(sessionId);
		return sub === undefined ? null : structuredClone(sub);
	}

	/** Every session currently opted in. */
	active(): SteeringSubscription[] {
		return [...this.subs.values()].filter((sub) => sub.optedIn).map((sub) => structuredClone(sub));
	}
}
