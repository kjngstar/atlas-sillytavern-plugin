import test from 'node:test';
import {proximityCases} from '../tools/map-lab/proximity-cases.mjs';

for(const entry of proximityCases)test('overview proximity: '+entry.name,entry.run);
