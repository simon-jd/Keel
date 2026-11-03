import {afterEach,expect,it,vi} from 'vitest';
import {createJudgePacer} from '../src/judgePacing.js';
afterEach(()=>vi.useRealTimers());
it('fixed monotonic starts are at least 4000ms apart including an invalid-schema retry',async()=>{
 vi.useFakeTimers({toFake:['performance','setTimeout']});const dispatch=createJudgePacer();const starts:number[]=[];
 const start=()=>{starts.push(performance.now());return Promise.resolve(starts.length);};
 expect(await dispatch(start)).toBe(1);
 let complete=false;const retry=dispatch(start).then(()=>{complete=true;});await vi.advanceTimersByTimeAsync(3999);expect(complete).toBe(false);expect(starts).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);await retry;expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(4000);
 const next=dispatch(start);await vi.advanceTimersByTimeAsync(4000);await next;expect(starts[2]!-starts[1]!).toBeGreaterThanOrEqual(4000);
});
