// When the converter of earlier-version records may start: never on the first refresh after launch, only once the
// app and the drive have been idle for a while, and never while the user has paused it (for this session).
export const MIGRATION_START_DELAY=30000;

export interface MigrationGate {
 /** Something used the drive (a job, a scan, a check, other I/O): the idle wait starts again from now. */
 busy():void;
 /** Milliseconds left before the converter may start; 0 when it may start now. Infinity while paused. */
 wait():number;
 readonly paused:boolean;
 pause():void;
 /** The user asked for it: it may start at the next idle moment, without the wait. */
 resume():void;
}

export function migrationGate(now:()=>number=Date.now,delay=MIGRATION_START_DELAY):MigrationGate {
 let since=now(),paused=false;
 return {
  busy(){since=Math.max(since,now());},
  wait(){return paused?Infinity:Math.max(0,delay-(now()-since));},
  get paused(){return paused;},
  pause(){paused=true;},
  resume(){paused=false;since=now()-delay;},
 };
}
