import { mkdtemp,writeFile,chmod,symlink,rm } from 'node:fs/promises';
import { expect,test } from 'vitest';
import { readSecretFile } from '../src/config.js';
// Reading broad-permission, symlinked or oversized credentials would leak trust-boundary secrets.
test('secret loader accepts only bounded owner files with exact 0600 permissions',async()=>{
 const dir=await mkdtemp('/tmp/keel-mcp-config-');try{
  await writeFile(dir+'/secret','fixture-secret',{mode:0o600});expect((await readSecretFile(dir+'/secret')).toString()).toBe('fixture-secret');
  await symlink(dir+'/secret',dir+'/link');await expect(readSecretFile(dir+'/link')).rejects.toThrow('CONFIG_INVALID');
  await chmod(dir+'/secret',0o644);await expect(readSecretFile(dir+'/secret')).rejects.toThrow('CONFIG_INVALID');
  await chmod(dir+'/secret',0o600);await writeFile(dir+'/secret','x'.repeat(65537));await expect(readSecretFile(dir+'/secret')).rejects.toThrow('CONFIG_INVALID');
 }finally{await rm(dir,{recursive:true,force:true});}
});
