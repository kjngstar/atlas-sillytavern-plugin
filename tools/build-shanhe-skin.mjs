import {buildArtworkSkin} from './build-artwork-skin.mjs';
console.log(JSON.stringify(await buildArtworkSkin({
  directory:'skins/shanhezhi',
  output:process.argv[2]||'release/Atlas-ShanheZhi-1.1.0.zip'
}),null,2));
