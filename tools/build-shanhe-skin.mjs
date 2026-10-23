import {buildArtworkSkin} from './build-artwork-skin.mjs';
console.log(JSON.stringify(await buildArtworkSkin({
  directory:'skins/shanhezhi',
  output:process.argv[2]||'skins/shanhezhi/Atlas-ShanheZhi-1.1.1.zip'
}),null,2));
