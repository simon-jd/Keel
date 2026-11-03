/** Fixed monotonic pacing at the actual physical fetch boundary; no live clock/config input. */
export type JudgeDispatchTiming={startedAtMonotonicMs:number;intervalMs:number|null};
export function createJudgePacer(){
 let previous:number|undefined;
 return async<T>(start:(timing:JudgeDispatchTiming)=>Promise<T>):Promise<T>=>{
  while(previous!==undefined&&performance.now()-previous<4000)await new Promise<void>(resolve=>setTimeout(resolve,4000-(performance.now()-previous!)));
  const now=performance.now(),timing={startedAtMonotonicMs:now,intervalMs:previous===undefined?null:now-previous};previous=now;
  return start(timing);
 };
}
