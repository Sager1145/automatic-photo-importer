/** What a job that has planned does about unknown files it found.
 * run: go on (nothing found, an automatic job that records a warning instead, or already confirmed).
 * park: a job someone started stops at the review's confirmation (nothing has been written).
 * defer: a review is open or another job is running, so it waits its turn and plans again later; it never opens a second
 * review over the first and never starts a review beside running work. */
export function unknownDecision(input:{found:boolean;automatic:boolean;confirmed:boolean;queuedAutomatically:boolean;reviewOpen:boolean;othersRunning:boolean}):'run'|'park'|'defer' {
 if(!input.found||input.automatic||input.confirmed||input.queuedAutomatically)return 'run';
 return input.reviewOpen||input.othersRunning?'defer':'park';
}
