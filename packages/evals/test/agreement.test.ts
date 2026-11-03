import {expect,test} from 'vitest';
import {agreement,cohensKappa,pairLabels} from '../src/agreement.js';
test('cohensKappaKnownValues: NCSS reproduction of Fleiss/Levin/Paik Example 6 ordinary kappa',()=>{
 const matrix=[[75,1,4],[5,4,1],[0,0,10]],a:string[]=[],b:string[]=[];
 matrix.forEach((row,i)=>row.forEach((n,j)=>{for(let k=0;k<n;k++){a.push(String(i));b.push(String(j));}}));
 const result=agreement(a,b);
 expect(result).toMatchObject({n:100,po:0.89,pe:0.66,matrix});
 expect(cohensKappa(a,b)).toBeCloseTo(23/34,12);
});
test('undefined and invalid labels are explicit failures',()=>{
 for(const [a,b] of [[[],[]],[['p'],['p']],[['p'],[]],[[NaN],[0]],[[Infinity],[0]],[[{}],[{}]]]) expect(()=>cohensKappa(a as string[],b as string[])).toThrow();
 expect(cohensKappa(['a','b'],['b','a'])).toBe(-1);
});
test('pair strictly by IDs and categories, never zip or silently intersect',()=>{
 expect(pairLabels([{id:'a',label:'pass'},{id:'b',label:'fail'}],[{id:'b',label:'pass'},{id:'a',label:'fail'}])).toEqual({ids:['a','b'],a:['pass','fail'],b:['fail','pass']});
 for(const records of [[{id:'a',label:'pass'},{id:'a',label:'fail'}],[{id:'b',label:'pass'}],[{id:'a',label:'other'}],[{id:'',label:'pass'}]]) expect(()=>pairLabels([{id:'a',label:'pass'}],records)).toThrow();
});
