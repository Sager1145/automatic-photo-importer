import {blockedActions} from '../gates';
import type {AppState} from '../shared';
/** A state as main publishes it: with the actions that must wait, worked out from the state alone (no internal work). */
export const gated=(state:AppState):AppState=>({...state,blocked:blockedActions(state,{active:false,duplicateScan:false,misplacedCheck:false,resuming:false})});
