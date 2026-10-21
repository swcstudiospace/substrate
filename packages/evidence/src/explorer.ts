/**
 * Where an anchor transaction can be checked outside the substrate (E-D1).
 *
 * Built from the signature alone, with no network call, so a bundle is the same
 * document whether or not the explorer is reachable (D41-2). The cluster is fixed to
 * devnet: the anchor only ever sends there, and verify refuses any other genesis hash.
 */
const DEVNET_TX_PAGE = "https://explorer.solana.com/tx/";

/** The Solana devnet transaction page for `signature`. */
export function devnetExplorerTxUrl(signature: string): string {
	return `${DEVNET_TX_PAGE}${encodeURIComponent(signature)}?cluster=devnet`;
}
