import { NodeIO } from '@gltf-transform/core';
import { readdirSync } from 'fs';
const io = new NodeIO();
for (const f of readdirSync('Models')) {
  const doc = await io.read('Models/' + f);
  const r = doc.getRoot();
  console.log(`\n== ${f}  ext:[${r.listExtensionsUsed().map(e=>e.extensionName)}]`);
  console.log('meshes', r.listMeshes().length, 'nodes', r.listNodes().length, 'textures', r.listTextures().map(t=>t.getMimeType()+':'+(t.getImage()?.byteLength|0)).join(','));
  console.log('materials:', r.listMaterials().map(m=>`${m.getName()}${m.getBaseColorTexture()?'[tex]':''}`).join(' | '));
  console.log('meshes:', r.listMeshes().slice(0,40).map(m=>m.getName()).join(' | '));
  const n = r.listNodes().find(n=>n.getMesh());
}
