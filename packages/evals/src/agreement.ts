/** Unweighted Cohen's kappa. Undefined agreement is an error, never fabricated 0/1. */
export type Label = string;
export interface Labeled {id:string;label:string}
export function agreement(a:Label[],b:Label[]) {
 if(!Array.isArray(a)||!Array.isArray(b)||!a.length||a.length!==b.length)throw new Error('INVALID_PAIR_COUNT');
 if([...a,...b].some(x=>typeof x!=='string'||!x.trim()))throw new Error('INVALID_CATEGORY');
 const categories=[...new Set([...a,...b])].sort();
 const matrix=categories.map(()=>categories.map(()=>0));
 for(let i=0;i<a.length;i++)matrix[categories.indexOf(a[i]!)]![categories.indexOf(b[i]!)]!++;
 const n=a.length,po=a.filter((x,i)=>x===b[i]).length/n;
 const pe=categories.reduce((sum,c)=>sum+a.filter(x=>x===c).length*b.filter(x=>x===c).length,0)/(n*n);
 if(pe===1)throw new Error('KAPPA_UNDEFINED_PE_ONE');
 const kappa=(po-pe)/(1-pe);
 if(!Number.isFinite(kappa)||kappa < -1-1e-12||kappa > 1+1e-12)throw new Error('INVALID_KAPPA_RANGE');
 return {n,po,pe,kappa,categories,matrix};
}
export function cohensKappa(a:Label[],b:Label[]):number{return agreement(a,b).kappa;}
export function labelMap(rows:Labeled[],categories:readonly string[]=['pass','fail']) {
 const map=new Map<string,string>();
 for(const row of rows){
  if(!row||typeof row.id!=='string'||!row.id.trim()||map.has(row.id))throw new Error('INVALID_OR_DUPLICATE_ID');
  if(!categories.includes(row.label))throw new Error('INVALID_CATEGORY');map.set(row.id,row.label);
 }
 return map;
}
export function pairLabels(a:Labeled[],b:Labeled[],categories:readonly string[]=['pass','fail']){
 const first=labelMap(a,categories),second=labelMap(b,categories),ids=[...first.keys()].sort();
 if(first.size!==second.size||ids.some(id=>!second.has(id)))throw new Error('PAIR_ID_MISMATCH');
 return {ids,a:ids.map(id=>first.get(id)!),b:ids.map(id=>second.get(id)!)};
}
