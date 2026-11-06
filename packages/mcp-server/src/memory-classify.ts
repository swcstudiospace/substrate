/**
 * The quarantine classifier.
 *
 * Three classes of text must not become memory that other agents act on:
 *
 *   - a **secret**, because redaction is a safety net and not a licence to store
 *     the thing it caught;
 *   - **PII**, because a repo's memory is read by eight agents and is not the
 *     place a person's phone number belongs;
 *   - a **speculative plan** asserted as a decision or a fact, because the whole
 *     value of a decision log is that the next agent can act on it without
 *     re-deriving it. "This is probably the cause" read as settled fact is worse
 *     than no entry at all.
 *
 * Quarantine is not a refusal. The entry is kept — redacted — where a reviewer can
 * see it, so the writer's work is not lost and the pattern that caught it can be
 * argued with. What quarantine costs is *visibility*: the entry does not reach a
 * brief or a search until it is released.
 */
import { redact } from "./redact.ts";
import type { MemoryKind, QuarantineReason } from "./types.ts";

interface Classification {
	reason: QuarantineReason;
	/** Names the pattern that fired. Never quotes the match — that is the point. */
	detail: string;
	/** Whether a reviewer's token may release the write. Never true for a secret. */
	reviewable: boolean;
}

/**
 * Addresses that are not a person.
 *
 * `git@github.com` is the SSH remote every repo has, and a commit trailer says
 * `noreply@anthropic.com`. Quarantining a memory for mentioning either would train
 * agents to stop writing commit provenance into memory, which is the opposite of
 * what this gate is for.
 */
const IMPERSONAL_ADDRESS = [
	/^git@/i,
	/^noreply@/i,
	/^no-reply@/i,
	/@users\.noreply\.github\.com$/i,
	/@(?:example|test|invalid|localhost)(?:\.[a-z]+)*$/i,
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * A phone number, recognised two ways and neither of them "a run of digits".
 *
 * A bare digit-and-punctuation regex matches version strings, ports, commit
 * counts and dates, and a classifier that fires on `v1.2.3-4567` is one operators
 * turn off. So: an international number must carry its `+`, and a national one
 * must be introduced by a word that says it is a phone number.
 */
const E164 = /\+\d[\d\s().-]{8,18}\d/g;
const LABELLED_PHONE = /\b(?:phone|mobile|cell|tel|telephone|whatsapp)\b\s*(?:number)?\s*[:=]?\s*([\d+][\d\s().-]{7,})/i;

/** US SSN shape. Distinctive enough to match on its own. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;

/** IBAN: country, check digits, then 11–30 more. The length range is the guard. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[A-Z0-9]{0,4}\b/g;

/** Payment-card candidates, confirmed by Luhn — the digits alone are far too common. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

function digitsOnly(value: string): string {
	return value.replace(/\D/g, "");
}

/** Luhn. The whole reason a card number is distinguishable from an id number. */
export function passesLuhn(digits: string): boolean {
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let digit = digits.charCodeAt(i) - 48;
		if (digit < 0 || digit > 9) return false;
		if (double) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		double = !double;
	}
	return sum % 10 === 0;
}

function personalEmail(text: string): string | null {
	for (const match of text.matchAll(EMAIL)) {
		const address = match[0];
		if (IMPERSONAL_ADDRESS.some((pattern) => pattern.test(address))) continue;
		return address;
	}
	return null;
}

function phoneNumber(text: string): boolean {
	for (const match of text.matchAll(E164)) {
		const digits = digitsOnly(match[0]);
		if (digits.length >= 10 && digits.length <= 15) return true;
	}
	const labelled = LABELLED_PHONE.exec(text);
	if (labelled?.[1]) {
		const digits = digitsOnly(labelled[1]);
		if (digits.length >= 7 && digits.length <= 15) return true;
	}
	return false;
}

function iban(text: string): boolean {
	for (const match of text.matchAll(IBAN)) {
		const compact = match[0].replace(/\s/g, "");
		if (compact.length >= 15 && compact.length <= 34) return true;
	}
	return false;
}

function paymentCard(text: string): boolean {
	for (const match of text.matchAll(CARD_CANDIDATE)) {
		if (passesLuhn(digitsOnly(match[0]))) return true;
	}
	return false;
}

/**
 * Hedging that turns an assertion into a guess.
 *
 * Checked only for `decision` and `fact`. A `todo` is *supposed* to be about
 * something that has not happened, a `handoff` describes what is left to do, and a
 * `warning` that hedges ("this might break the poller") is exactly the warning
 * worth having. Quarantining those would gut the three kinds agents write most.
 *
 * A bare "will" is missing on purpose: "we will use herdr" is a decision, not a
 * speculation, and it is how most real decisions are phrased.
 */
const SPECULATIVE =
	/\b(?:probably|perhaps|maybe|might|i think|i believe|not sure|unsure|unverified|untested|assum(?:e|es|ed|ing|ption)|should work|seems? to|appears? to|plan(?:ning|s)? to|intend(?:s|ing)? to|likely|tbd|to be decided|guess(?:ing)?|hypothesis|hypothetical|speculat\w+|proposed plan|draft plan|if this works)\b/i;

const SPECULATION_APPLIES: readonly MemoryKind[] = ["decision", "fact"];

/**
 * Classify a memory body, or return null when it is clean.
 *
 * Order matters: a secret wins over everything, because it is the one class that
 * no reviewer can release and the one where storing the text as-written is itself
 * the harm.
 */
export function classify(text: string, kind: MemoryKind): Classification | null {
	if (redact(text) !== text) {
		return {
			reason: "secret",
			// Deliberately does not say which rule matched. A message like "matched the
			// GitHub PAT rule" is itself a hint about the value that was pasted.
			detail: "the text carried something the redactor recognised as a credential",
			reviewable: false,
		};
	}

	if (personalEmail(text)) {
		return { reason: "pii", detail: "the text carried an email address", reviewable: true };
	}
	if (phoneNumber(text)) {
		return { reason: "pii", detail: "the text carried a phone number", reviewable: true };
	}
	if (SSN.test(text)) {
		return { reason: "pii", detail: "the text carried a national-identifier pattern", reviewable: true };
	}
	if (paymentCard(text)) {
		return { reason: "pii", detail: "the text carried a payment-card number", reviewable: true };
	}
	if (iban(text)) {
		return { reason: "pii", detail: "the text carried a bank-account number", reviewable: true };
	}

	if (SPECULATION_APPLIES.includes(kind)) {
		const hedge = SPECULATIVE.exec(text);
		if (hedge) {
			return {
				reason: "speculative",
				detail: `a ${kind} hedged with "${hedge[0]}" is a plan, not a ${kind}`,
				reviewable: true,
			};
		}
	}

	return null;
}
