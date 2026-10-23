/** Whether a job that found unknown files must stop at a confirmation before it starts. A started job
 * (Start, Import now, Organize now, Organize backup...) asks; an automatic one never waits, it records a warning
 * instead; one the user already confirmed (and its retries) does not ask again. */
export function needsUnknownConfirmation(input:{found:boolean;automatic:boolean;confirmed:boolean;queuedAutomatically:boolean}):boolean {
 return input.found&&!input.automatic&&!input.confirmed&&!input.queuedAutomatically;
}
