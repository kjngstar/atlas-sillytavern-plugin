import {buildArtworkSkin} from './build-artwork-skin.mjs';
console.log(JSON.stringify(await buildArtworkSkin({
  directory:'skins/qingkong-xinjian',
  output:process.argv[2]||'skins/qingkong-xinjian/Atlas-QingkongXinjian-1.0.0.zip'
}),null,2));
