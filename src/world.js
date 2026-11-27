import * as THREE from 'three';
import { Foliage, patchHide, hiddenDepth } from './foliage.js';

// World frame: X = east, Y = up, Z = south (metres, L-EST97 shifted to ORIGIN).
export const ORIGIN_E = 542000, ORIGIN_N = 6589000;
const TILE = 'https://tiles.maaamet.ee/tm/tms/1.0.0/foto/';
const GRID_E = 40500, GRID_N = 5993000; // Maa-amet L-EST tile grid origin
const RES0 = 4000; // m/px at z0
const NEAR_Z = 14; // 0.244 m/px close to the car

export const toWorld = ( E, N, H = 0 ) => new THREE.Vector3( E - ORIGIN_E, H, - ( N - ORIGIN_N ) );

// ---------- orthophoto tiles ----------
const tileCache = new Map();
function loadTile( z, x, y ) {

	const key = z + '/' + x + '/' + y;
	let p = tileCache.get( key );
	if ( ! p ) {

		p = new Promise( resolve => {

			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => resolve( img );
			img.onerror = () => resolve( null );
			img.src = TILE + key + '.jpg';

		} );
		tileCache.set( key, p );
		if ( tileCache.size > 1500 ) tileCache.delete( tileCache.keys().next().value );

	}

	return p;

}

async function composeOrtho( z, e0, n0, size, px, isAlive ) {

	const tileM = RES0 / 2 ** z * 256;
	const canvas = document.createElement( 'canvas' );
	canvas.width = canvas.height = px;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = '#7d8a6b';
	ctx.fillRect( 0, 0, px, px );
	const k = px / size;
	const tx0 = Math.floor( ( e0 - GRID_E ) / tileM ), tx1 = Math.floor( ( e0 + size - 1e-6 - GRID_E ) / tileM );
	const ty0 = Math.floor( ( n0 - GRID_N ) / tileM ), ty1 = Math.floor( ( n0 + size - 1e-6 - GRID_N ) / tileM );
	const jobs = [];
	for ( let tx = tx0; tx <= tx1; tx ++ ) for ( let ty = ty0; ty <= ty1; ty ++ ) {

		jobs.push( loadTile( z, tx, ty ).then( img => {

			if ( ! img || ! isAlive() ) return;
			const te = GRID_E + tx * tileM, tn = GRID_N + ( ty + 1 ) * tileM;
			ctx.drawImage( img, ( te - e0 ) * k, ( n0 + size - tn ) * k, tileM * k + 0.5, tileM * k + 0.5 );

		} ) );

	}

	await Promise.all( jobs );
	return canvas;

}

const PLACEHOLDER = new THREE.DataTexture( new Uint8Array( [ 125, 138, 107, 255 ] ), 1, 1 );
PLACEHOLDER.colorSpace = THREE.SRGBColorSpace;
PLACEHOLDER.needsUpdate = true;

// fine grain noise so the ground does not look like a blurry photo up close
const DETAIL = ( () => {

	const c = document.createElement( 'canvas' );
	c.width = c.height = 256;
	const x = c.getContext( '2d' );
	const img = x.createImageData( 256, 256 );
	for ( let i = 0; i < 256 * 256; i ++ ) {

		const v = 128 + ( Math.random() - 0.5 ) * 70 + ( Math.random() - 0.5 ) * 30;
		img.data[ i * 4 ] = img.data[ i * 4 + 1 ] = img.data[ i * 4 + 2 ] = v;
		img.data[ i * 4 + 3 ] = 255;

	}

	x.putImageData( img, 0, 0 );
	// soften a little: blend a blurred copy for low-frequency mottling
	x.globalAlpha = 0.5;
	x.filter = 'blur(3px)';
	x.drawImage( c, 0, 0 );
	const t = new THREE.CanvasTexture( c );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.anisotropy = 8;
	return t;

} )();

export const GROUND_TINT = new THREE.Color().setRGB( 1.3, 1.33, 1.4, THREE.LinearSRGBColorSpace );
function groundMaterial( offset ) {

	// lit so it takes shadows; the tint cancels the sky+sun light so the photo keeps its own brightness
	const m = new THREE.MeshLambertMaterial( { color: GROUND_TINT, map: PLACEHOLDER, polygonOffset: !! offset, polygonOffsetFactor: offset || 0, polygonOffsetUnits: offset || 0 } );
	m.onBeforeCompile = s => {

		s.uniforms.uDetail = { value: DETAIL };
		s.vertexShader = s.vertexShader
			.replace( '#include <common>', '#include <common>\nvarying vec3 vGW;' )
			.replace( '#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' )
			.replace( '#include <fog_vertex>', '#include <fog_vertex>\nvGW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' );
		s.fragmentShader = s.fragmentShader
			.replace( '#include <common>', '#include <common>\nvarying vec3 vGW;\nuniform sampler2D uDetail;' )
			.replace( '#include <map_fragment>', `#include <map_fragment>
				float dn = texture2D( uDetail, vGW.xz * 0.45 ).r * 0.65 + texture2D( uDetail, vGW.xz * 0.07 ).r * 0.35;
				diffuseColor.rgb *= 0.8 + dn * 0.42;` );

	};

	return m;

}

// separable [1 4 6 4 1] blur, applied twice (about 30 m on the 10 m grid); returns decimetres as floats
function blur( src, w ) {

	let a = Float32Array.from( src ), b = new Float32Array( a.length );
	const K = [ 1, 4, 6, 4, 1 ];
	for ( let pass = 0; pass < 1; pass ++ ) {

		for ( let y = 0; y < w; y ++ ) for ( let x = 0; x < w; x ++ ) {

			let s = 0, n = 0;
			for ( let k = - 2; k <= 2; k ++ ) { const xx = x + k; if ( xx < 0 || xx >= w ) continue; s += a[ y * w + xx ] * K[ k + 2 ]; n += K[ k + 2 ]; }
			b[ y * w + x ] = s / n;

		}

		for ( let y = 0; y < w; y ++ ) for ( let x = 0; x < w; x ++ ) {

			let s = 0, n = 0;
			for ( let k = - 2; k <= 2; k ++ ) { const yy = y + k; if ( yy < 0 || yy >= w ) continue; s += b[ yy * w + x ] * K[ k + 2 ]; n += K[ k + 2 ]; }
			a[ y * w + x ] = s / n;

		}

	}

	return a;

}

// ---------- building material ----------
// walls get a style from the building height (houses, apartments, panel blocks, glass towers), roofs get the photo
function buildingMaterial() {

	const m = new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true, side: THREE.DoubleSide, map: PLACEHOLDER } );
	m.onBeforeCompile = s => {

		s.vertexShader = s.vertexShader
			.replace( '#include <common>', '#include <common>\nattribute vec2 aBT;\nvarying vec3 vWPos;\nvarying vec2 vBT;' )
			.replace( '#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvBT = aBT;' );
		s.fragmentShader = s.fragmentShader
			.replace( '#include <common>', `#include <common>
				varying vec3 vWPos;
				varying vec2 vBT;
				float gRoof; vec3 gPhoto; float gGlass;
				float h1( float n ) { return fract( sin( n * 12.9898 ) * 43758.5453 ); }
				float box( vec2 p, vec2 lo, vec2 hi ) { vec2 a = smoothstep( lo, lo + 0.03, p ) * smoothstep( hi, hi - 0.03, p ); return a.x * a.y; }` )
			.replace( '#include <map_fragment>', `
				vec3 wN = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) );
				gRoof = smoothstep( 0.35, 0.6, abs( wN.y ) );
				gPhoto = texture2D( map, vMapUv ).rgb;
				float H = vBT.y - vBT.x;
				float y = vWPos.y - vBT.x;
				float seed = h1( vBT.x * 3.1 + vBT.y * 7.7 );
				vec2 t2 = normalize( vec2( - wN.z, wN.x ) + 1e-5 );
				float u = dot( vWPos.xz, t2 );
				vec3 wall; float floorH; float pitch; vec2 wlo; vec2 whi; vec3 glassC = vec3( 0.16, 0.21, 0.27 );
				gGlass = 0.0;
				if ( H < 7.5 ) {          // small houses: wooden / plaster, lively colours
					vec3 pal[6]; pal[0]=vec3(.82,.72,.52); pal[1]=vec3(.62,.72,.66); pal[2]=vec3(.78,.55,.45); pal[3]=vec3(.85,.82,.72); pal[4]=vec3(.55,.63,.74); pal[5]=vec3(.88,.78,.58);
					wall = pal[ int( seed * 5.99 ) ]; floorH = 3.0; pitch = 2.6; wlo = vec2( .32, .35 ); whi = vec2( .68, .78 );
				} else if ( H < 21.0 || length( vWPos.xz - vec2( 295.0, - 50.0 ) ) < 950.0 ) {  // apartments / old town plaster and brick
					vec3 pal[5]; pal[0]=vec3(.88,.83,.72); pal[1]=vec3(.80,.70,.52); pal[2]=vec3(.66,.38,.30); pal[3]=vec3(.86,.86,.84); pal[4]=vec3(.78,.74,.62);
					wall = pal[ int( seed * 4.99 ) ]; floorH = 3.3; pitch = 3.0; wlo = vec2( .3, .32 ); whi = vec2( .7, .8 );
				} else if ( H < 55.0 ) {  // soviet panel blocks
					wall = mix( vec3( .74, .74, .72 ), vec3( .82, .80, .74 ), seed ); floorH = 2.8; pitch = 3.6; wlo = vec2( .22, .3 ); whi = vec2( .78, .78 );
					float seam = max( 1.0 - smoothstep( 0.0, 0.025, abs( fract( y / floorH ) - 0.02 ) ), 1.0 - smoothstep( 0.0, 0.012, abs( fract( u / ( pitch * 2.0 ) ) - 0.5 ) ) );
					wall *= 1.0 - seam * 0.25;
				} else {                  // towers: glass curtain wall
					wall = mix( vec3( .32, .42, .52 ), vec3( .45, .52, .58 ), seed ); floorH = 3.6; pitch = 1.6; wlo = vec2( .04, .06 ); whi = vec2( .96, .94 );
					glassC = wall * 0.7; gGlass = 1.0;
				}
				vec2 cell = vec2( fract( u / pitch ), fract( y / floorH ) );
				float fl = floor( y / floorH );
				float win = box( cell, wlo, whi );
				// far away the window grid turns into noise: fade it to its average coverage
				float fw = max( fwidth( u / pitch ), fwidth( y / floorH ) );
				win = mix( win, ( whi.x - wlo.x ) * ( whi.y - wlo.y ), smoothstep( 0.06, 0.22, fw ) );
				win *= step( 0.6, y ) * step( y, H - 0.6 ) * ( 1.0 - gRoof );
				// ground floor: shop windows on bigger buildings, a darker plinth otherwise
				if ( fl < 0.5 && H > 9.0 && H < 55.0 ) {
					float shop = step( 0.5, h1( floor( u / 7.0 ) + seed * 31.0 ) );
					win = mix( win, box( vec2( fract( u / 7.0 ), cell.y ), vec2( .06, .12 ), vec2( .94, .82 ) ), shop * ( 1.0 - smoothstep( 0.06, 0.22, fw ) ) );
				}
				float lit = step( 0.82, h1( floor( u / pitch ) * 3.7 + fl * 11.3 + seed ) );
				vec3 glass = mix( glassC, vec3( 0.95, 0.85, 0.6 ) * 0.7, lit * 0.25 );
				// subtle sky reflection on glass
				glass += vec3( 0.07, 0.09, 0.12 ) * ( 1.0 - cell.y );
				wall *= 0.93 + 0.07 * smoothstep( 0.0, 1.0, fract( u / 23.0 + seed ) ); // gentle variation along the facade
				wall *= mix( 0.72, 1.0, smoothstep( 0.0, 0.9, y ) );         // dark plinth / dirt
				wall *= mix( 1.0, 1.12, smoothstep( H - 0.5, H - 0.1, y ) ); // parapet edge
				vec3 col = mix( wall, glass, win );
				diffuseColor.rgb = mix( col, vec3( 0.0 ), gRoof );
				gGlass = max( gGlass, win );
			` )
			.replace( '#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, 0.18, gGlass * ( 1.0 - gRoof ) );' )
			.replace( '#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, 0.35, gGlass * ( 1.0 - gRoof ) );' )
			.replace( '#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gPhoto * gRoof * 0.95;' );

	};

	return m;

}

// ---------- trees ----------
const crownDecid = ( () => {

	const g = new THREE.IcosahedronGeometry( 1, 1 );
	const p = g.attributes.position;
	for ( let i = 0; i < p.count; i ++ ) {

		const k = 0.82 + 0.3 * Math.abs( Math.sin( p.getX( i ) * 5.1 + p.getY( i ) * 3.7 + p.getZ( i ) * 4.3 ) );
		p.setXYZ( i, p.getX( i ) * k, p.getY( i ) * k, p.getZ( i ) * k );

	}

	g.computeVertexNormals();
	return g;

} )();
const crownConif = new THREE.ConeGeometry( 1, 1, 7 ).translate( 0, 0.5, 0 );
const trunkGeo = new THREE.CylinderGeometry( 0.35, 0.5, 1, 6 ).translate( 0, 0.5, 0 );
const treeMats = {
	trunk: new THREE.MeshStandardMaterial( { color: 0x5a4636, roughness: 1, flatShading: true } ),
	crown: new THREE.MeshStandardMaterial( { color: 0xffffff, roughness: 0.95, flatShading: true } ),
};
patchHide( treeMats.trunk ); patchHide( treeMats.crown );
const BUSH = 3.5;
// lidar heights are real (median ~17 m); scaled a little so the street reads better next to the car
const TREE_SCALE = 0.8;
// the ground photo sits a little below the true surface so the vector streets always draw on top of it
const GROUND_SINK = 0.12;

// ---------- the world ----------
export class World {

	constructor( scene ) {

		this.scene = scene;
		this.group = new THREE.Group();
		scene.add( this.group );
		this.chunks = new Map();
		this.patches = new Map();
		this.tiles = new Map(); // terrain tiles
		this.ready = false;
		this.radius = 3;
		this.falling = [];
		this.onTreeFall = null;
		this.foliage = new Foliage( this );

	}

	async init() {

		this.manifest = await ( await fetch( './city/manifest.json' ) ).json();
		const t = this.manifest.terrain;
		this.t = t;
		this.coarse = new Int16Array( await ( await fetch( './city/coarse.bin' ) ).arrayBuffer() );
		this.hasBuildings = new Set( this.manifest.chunks.map( c => c[ 0 ] + '_' + c[ 1 ] ) );
		this.hasTrees = new Set( this.manifest.treeChunks.map( c => c[ 0 ] + '_' + c[ 1 ] ) );
		try { Object.assign( this.manifest, await ( await fetch( './city/extra.json' ) ).json() ); } catch { /* optional */ }
		this.ready = true;
		this.foliage.setDetail( this.radius <= 2 );
		this.foliage.load().catch( e => console.warn( 'tree models', e ) );

	}

	// ---------- terrain ----------
	tileKey( E, N ) {

		const t = this.t, span = t.tile * t.cell;
		return [ Math.floor( ( E - t.e0 ) / span ), Math.floor( ( N - t.n0 ) / span ) ];

	}

	loadTerrain( tx, ty ) {

		const key = tx + '_' + ty;
		let e = this.tiles.get( key );
		if ( ! e ) {

			e = { data: null };
			const t = this.t;
			e.promise = tx < 0 || ty < 0 || tx >= t.tiles || ty >= t.tiles
				? Promise.resolve()
				: fetch( `./city/h_${key}.bin` ).then( r => r.arrayBuffer() ).then( b => { e.data = new Int16Array( b ); e.smooth = blur( e.data, t.tile + 1 ); } ).catch( () => {} );
			this.tiles.set( key, e );

		}

		return e.promise;

	}

	// one smoothed height field for everything (ground, roads, trees, physics): no steps, no pits
	height( x, z ) { return this.sample( x, z, true ); }

	heightRaw( x, z ) { return this.sample( x, z, false ); }

	// terrain blurred over ~30 m: roads and their physics use this, so streets are not wavy
	heightSmooth( x, z ) { return this.sample( x, z, true ); }

	sample( x, z, smooth ) {

		const t = this.t;
		const E = x + ORIGIN_E, N = - z + ORIGIN_N;
		const span = t.tile * t.cell;
		const tx = Math.floor( ( E - t.e0 ) / span ), ty = Math.floor( ( N - t.n0 ) / span );
		const e = this.tiles.get( tx + '_' + ty );
		let d, w, gx, gy, nx;
		if ( e && e.data ) {

			d = smooth ? e.smooth : e.data; w = t.tile + 1; nx = w;
			gx = ( E - t.e0 - tx * span ) / t.cell; gy = ( N - t.n0 - ty * span ) / t.cell;

		} else {

			d = this.coarse; w = t.coarseW; nx = w;
			gx = ( E - t.e0 ) / t.coarse; gy = ( N - t.n0 ) / t.coarse;

		}

		const x0 = Math.max( 0, Math.min( nx - 2, Math.floor( gx ) ) ), y0 = Math.max( 0, Math.min( nx - 2, Math.floor( gy ) ) );
		const ax = Math.min( 1, Math.max( 0, gx - x0 ) ), ay = Math.min( 1, Math.max( 0, gy - y0 ) );
		const a = d[ y0 * w + x0 ], b = d[ y0 * w + x0 + 1 ], c = d[ ( y0 + 1 ) * w + x0 ], f = d[ ( y0 + 1 ) * w + x0 + 1 ];
		return ( ( a * ( 1 - ax ) + b * ax ) * ( 1 - ay ) + ( c * ( 1 - ax ) + f * ax ) * ay ) / 10;

	}

	// surface type under (x,z): 0 off-road (grass/gravel), 1 asphalt, 2 paving, 3 gravel road, 4 cobbles
	surface( x, z ) { return this.roads ? this.roads.surface( x, z ) : 0; }

	// height of the ground photo: a little below the terrain, and well below any street drawn on top
	visGround( x, z ) {

		const h = this.height( x, z ) - GROUND_SINK;
		return h;

	}

	// drivable surface under yRef: bridge deck, street (smoothed) or ground
	ground( x, z, yRef ) {

		if ( this.roads ) {

			const d = this.roads.deckY( x, z, yRef );
			if ( d !== null ) return d;
			if ( this.roads.surface( x, z ) ) return this.heightSmooth( x, z ) + 0.065;

		}

		return this.height( x, z ) - 0.03;

	}

	groundNormal( x, z, yRef, out = new THREE.Vector3() ) {

		const e = 1.0;
		const dx = this.ground( x + e, z, yRef ) - this.ground( x - e, z, yRef ), dz = this.ground( x, z + e, yRef ) - this.ground( x, z - e, yRef );
		return out.set( - dx, 2 * e, - dz ).normalize();

	}

	// after streets are built, push the photo ground under them
	resinkGround( x0, z0, x1, z1 ) {

		const fix = mesh => {

			if ( ! mesh ) return;
			const g = mesh.geometry, p = g.attributes.position;
			if ( ! g.boundingBox ) g.computeBoundingBox();
			const b = g.boundingBox;
			if ( b.max.x < x0 || b.min.x > x1 || b.max.z < z0 || b.min.z > z1 ) return;
			for ( let i = 0; i < p.count; i ++ ) p.setY( i, this.visGround( p.getX( i ), p.getZ( i ) ) + ( mesh.userData.lift || 0 ) );
			p.needsUpdate = true;
			g.computeVertexNormals();

		};

		for ( const c of this.chunks.values() ) fix( c.ground );
		for ( const p of this.patches.values() ) fix( p.mesh );

	}

	normal( x, z, out = new THREE.Vector3() ) {

		const e = 2;
		const hx = this.height( x + e, z ) - this.height( x - e, z );
		const hz = this.height( x, z + e ) - this.height( x, z - e );
		return out.set( - hx, 2 * e, - hz ).normalize();

	}

	chunkOf( x, z ) {

		const { gridE, gridN, chunk } = this.manifest;
		return [ Math.floor( ( x + ORIGIN_E - gridE ) / chunk ), Math.floor( ( - z + ORIGIN_N - gridN ) / chunk ) ];

	}

	// ---------- streaming ----------
	update( x, z ) {

		if ( ! this.ready ) return 0;
		const [ cx, cy ] = this.chunkOf( x, z );
		const R = this.radius;
		const want = new Set();
		for ( let dy = - R; dy <= R; dy ++ ) for ( let dx = - R; dx <= R; dx ++ ) {

			if ( dx * dx + dy * dy > ( R + 0.5 ) ** 2 ) continue;
			const key = ( cx + dx ) + '_' + ( cy + dy );
			want.add( key );
			const ring = Math.max( Math.abs( dx ), Math.abs( dy ) );
			let c = this.chunks.get( key );
			if ( ! c ) this.chunks.set( key, c = this.loadChunk( cx + dx, cy + dy ) );
			const wantZ = ring <= 1 ? 13 : ring <= 2 ? 12 : 11;
			if ( c.texZ !== wantZ && ! c.texBusy ) this.retexture( c, wantZ );
			if ( c.treesLod < 0 && c.treeData ) this.buildTrees( c, 1 );

		}

		for ( const [ key, c ] of this.chunks ) if ( ! want.has( key ) ) this.unload( key, c );
		this.updatePatches( x, z );
		this.foliage.update( x, z );

		let ok = 0;
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const c = this.chunks.get( ( cx + dx ) + '_' + ( cy + dy ) );
			if ( c && c.loaded ) ok ++;

		}

		return ok / 9;

	}

	loadChunk( cx, cy ) {

		const { gridE, gridN, chunk } = this.manifest;
		const e0 = gridE + cx * chunk, n0 = gridN + cy * chunk;
		const c = { cx, cy, e0, n0, alive: true, loaded: false, texZ: 0, texBusy: false, ground: null, bld: null, trees: null, treesLod: - 1 };
		c.rect = { e0: e0 - 125, n0: n0 - 125, size: chunk + 250 };
		c.material = groundMaterial( 0 );
		c.bmat = buildingMaterial();
		const key = cx + '_' + cy;
		const [ tx, ty ] = this.tileKey( e0 + 1, n0 + 1 );

		const jobs = [ this.loadTerrain( tx, ty ).then( () => {

			if ( ! c.alive ) return;
			const n = 51, step = chunk / ( n - 1 );
			const g = new THREE.PlaneGeometry( 1, 1, n - 1, n - 1 );
			const p = g.attributes.position, uv = g.attributes.uv;
			for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

				const k = j * n + i;
				const E = e0 + i * step, N = n0 + chunk - j * step;
				const x = E - ORIGIN_E, z = - ( N - ORIGIN_N );
				p.setXYZ( k, x, this.visGround( x, z ), z );
				uv.setXY( k, ( E - c.rect.e0 ) / c.rect.size, ( N - c.rect.n0 ) / c.rect.size );

			}

			g.computeVertexNormals();
			c.ground = new THREE.Mesh( g, c.material );
			this.group.add( c.ground );

		} ) ];

		if ( this.hasBuildings.has( key ) ) {

			jobs.push( fetch( `./city/c_${key}.bin` ).then( r => r.arrayBuffer() ).then( buf => {

				if ( ! c.alive ) return;
				c.bld = this.makeBuildings( buf, c );
				this.group.add( c.bld );

			} ).catch( () => {} ) );

		}

		if ( this.hasTrees.has( key ) ) {

			jobs.push( Promise.all( [ fetch( `./city/t_${key}.bin` ).then( r => r.arrayBuffer() ), jobs[ 0 ] ] ).then( ( [ buf ] ) => {

				if ( ! c.alive ) return;
				this.parseTrees( buf, c );

			} ).catch( () => {} ) );

		}

		Promise.all( jobs ).then( () => { c.loaded = true; } );
		return c;

	}

	makeBuildings( buf, c ) {

		const hdr = new Uint32Array( buf, 0, 4 );
		const nv = hdr[ 1 ], ni = hdr[ 2 ], wide = hdr[ 3 ];
		const q = new Int16Array( buf, 16, nv * 3 );
		const aOff = 16 + ( nv * 3 + ( ( nv * 3 ) % 2 ) ) * 2;
		const aq = new Int16Array( buf, aOff, nv * 2 );
		const iOff = aOff + nv * 4;
		const idx = wide ? new Uint32Array( buf.slice( iOff ) ) : new Uint16Array( buf.slice( iOff ) );
		const pos = new Float32Array( nv * 3 ), uv = new Float32Array( nv * 2 ), bt = new Float32Array( nv * 2 );
		const ox = c.e0 - ORIGIN_E, oz = - ( c.n0 - ORIGIN_N );
		for ( let i = 0; i < nv; i ++ ) {

			const de = q[ i * 3 ] / 10, h = q[ i * 3 + 1 ] / 10, dn = q[ i * 3 + 2 ] / 10;
			pos[ i * 3 ] = ox + de;
			pos[ i * 3 + 1 ] = h;
			pos[ i * 3 + 2 ] = oz - dn;
			uv[ i * 2 ] = ( c.e0 + de - c.rect.e0 ) / c.rect.size;
			uv[ i * 2 + 1 ] = ( c.n0 + dn - c.rect.n0 ) / c.rect.size;
			bt[ i * 2 ] = aq[ i * 2 ] / 10;
			bt[ i * 2 + 1 ] = aq[ i * 2 + 1 ] / 10;

		}

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
		g.setAttribute( 'uv', new THREE.BufferAttribute( uv, 2 ) );
		g.setAttribute( 'aBT', new THREE.BufferAttribute( bt, 2 ) );
		g.setIndex( new THREE.BufferAttribute( idx.subarray( 0, ni ), 1 ) );
		g.computeBoundingSphere();
		g.computeBoundsTree();
		return new THREE.Mesh( g, c.bmat );

	}

	// ---------- trees ----------
	parseTrees( buf, c ) {

		const dv = new DataView( buf );
		const n = dv.getUint32( 0, true );
		const T = { n, x: new Float32Array( n ), z: new Float32Array( n ), y: new Float32Array( n ), h: new Float32Array( n ), cr: new Float32Array( n ), conif: new Uint8Array( n ), fallen: new Uint8Array( n ) };
		const ox = c.e0 - ORIGIN_E, oz = - ( c.n0 - ORIGIN_N );
		for ( let i = 0; i < n; i ++ ) {

			const o = 4 + i * 8;
			T.x[ i ] = ox + dv.getUint16( o, true ) / 100;
			T.z[ i ] = oz - dv.getUint16( o + 2, true ) / 100;
			T.h[ i ] = Math.max( 1, dv.getUint8( o + 4 ) / 4 * TREE_SCALE );
			T.cr[ i ] = Math.max( 1, dv.getUint8( o + 5 ) / 8 * TREE_SCALE );
			T.conif[ i ] = dv.getUint8( o + 6 );
			T.y[ i ] = this.height( T.x[ i ], T.z[ i ] );

		}

		c.treeData = T;

	}

	treeMatrices( T, i, m, part, fall ) {

		const h = T.h[ i ], cr = T.cr[ i ], bush = h < BUSH;
		const pos = new THREE.Vector3( T.x[ i ], T.y[ i ], T.z[ i ] );
		const q = new THREE.Quaternion();
		if ( fall ) q.setFromAxisAngle( fall.axis, fall.angle );
		const local = new THREE.Matrix4();
		if ( part === 'trunk' ) {

			const r = bush ? 0 : Math.min( 0.45, 0.12 + h * 0.012 );
			local.compose( new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3( r * 2, bush ? 0.001 : h * ( T.conif[ i ] ? 0.35 : 0.55 ), r * 2 ) );

		} else if ( T.conif[ i ] && ! bush ) {

			const r = Math.min( cr * 0.42, h * 0.26 );
			local.compose( new THREE.Vector3( 0, h * 0.15, 0 ), new THREE.Quaternion(), new THREE.Vector3( r, h * 0.85, r ) );

		} else {

			const r = bush ? Math.max( h * 0.55, cr * 0.5 ) : Math.max( 1, Math.min( cr * 0.42, h * 0.3 ) );
			const ry = bush ? h * 0.5 : Math.max( r * 0.95, h * 0.3 );
			local.compose( new THREE.Vector3( 0, bush ? h * 0.45 : h - ry, 0 ), new THREE.Quaternion(), new THREE.Vector3( r, ry, r ) );

		}

		m.compose( pos, q, new THREE.Vector3( 1, 1, 1 ) ).multiply( local );
		return m;

	}

	buildTrees( c, lod ) {

		const T = c.treeData;
		if ( c.trees ) { this.group.remove( c.trees ); c.trees.children.forEach( m => m.dispose() ); }
		c.treesLod = lod;
		const g = new THREE.Group();
		const decid = [], conif = [];
		for ( let i = 0; i < T.n; i ++ ) ( T.conif[ i ] && T.h[ i ] >= BUSH ? conif : decid ).push( i );
		const crownD = new THREE.InstancedMesh( lod ? crownDecid : crownDecid, treeMats.crown, Math.max( 1, decid.length ) );
		const crownC = new THREE.InstancedMesh( crownConif, treeMats.crown, Math.max( 1, conif.length ) );
		const trunks = new THREE.InstancedMesh( trunkGeo, treeMats.trunk, Math.max( 1, T.n ) );
		const m = new THREE.Matrix4(), col = new THREE.Color();
		T.slot = new Int32Array( T.n );
		decid.forEach( ( i, k ) => {

			crownD.setMatrixAt( k, this.treeMatrices( T, i, m, 'crown', T.fallen[ i ] ? T.fall?.[ i ] : null ) );
			const s = ( Math.sin( i * 91.7 ) * 0.5 + 0.5 );
			col.setRGB( 0.24 + s * 0.12, 0.42 + s * 0.12, 0.16 + s * 0.06 );
			if ( T.h[ i ] < BUSH ) col.multiplyScalar( 0.85 );
			crownD.setColorAt( k, col );
			T.slot[ i ] = k;

		} );
		conif.forEach( ( i, k ) => {

			crownC.setMatrixAt( k, this.treeMatrices( T, i, m, 'crown', T.fallen[ i ] ? T.fall?.[ i ] : null ) );
			const s = ( Math.sin( i * 37.3 ) * 0.5 + 0.5 );
			col.setRGB( 0.12 + s * 0.06, 0.27 + s * 0.08, 0.16 + s * 0.05 );
			crownC.setColorAt( k, col );
			T.slot[ i ] = k;

		} );
		for ( let i = 0; i < T.n; i ++ ) trunks.setMatrixAt( i, this.treeMatrices( T, i, m, 'trunk', T.fallen[ i ] ? T.fall?.[ i ] : null ) );
		crownD.count = decid.length; crownC.count = conif.length;
		crownD.instanceColor && ( crownD.instanceColor.needsUpdate = true );
		crownC.instanceColor && ( crownC.instanceColor.needsUpdate = true );
		for ( const im of [ crownD, crownC, trunks ] ) { im.computeBoundingSphere(); im.customDepthMaterial = hiddenDepth; g.add( im ); }
		T.meshes = { crownD, crownC, trunks };
		c.trees = g;
		this.group.add( g );

	}

	// standing trees (not bushes) within r of (x,z)
	treesNear( x, z, r, out = [] ) {

		out.length = 0;
		const [ cx, cy ] = this.chunkOf( x, z );
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const c = this.chunks.get( ( cx + dx ) + '_' + ( cy + dy ) );
			const T = c && c.treeData;
			if ( ! T ) continue;
			for ( let i = 0; i < T.n; i ++ ) {

				if ( T.fallen[ i ] || T.h[ i ] < BUSH ) continue;
				const ddx = T.x[ i ] - x, ddz = T.z[ i ] - z;
				if ( ddx * ddx + ddz * ddz < r * r ) out.push( { c, i, x: T.x[ i ], z: T.z[ i ], y: T.y[ i ], h: T.h[ i ], r: Math.min( 0.45, 0.12 + T.h[ i ] * 0.012 ) } );

			}

		}

		if ( this.props ) this.props.near( x, z, r, out );
		return out;

	}

	// is (x,z) inside a bush? returns 0..1
	inBush( x, z ) {

		const [ cx, cy ] = this.chunkOf( x, z );
		const c = this.chunks.get( cx + '_' + cy );
		const T = c && c.treeData;
		if ( ! T ) return 0;
		for ( let i = 0; i < T.n; i ++ ) {

			if ( T.h[ i ] >= BUSH ) continue;
			const r = Math.max( T.h[ i ] * 0.55, T.cr[ i ] * 0.5 );
			const ddx = T.x[ i ] - x, ddz = T.z[ i ] - z;
			if ( ddx * ddx + ddz * ddz < r * r ) return 1;

		}

		return 0;

	}

	fellTree( tree, dirX, dirZ ) {

		if ( tree.fell ) return tree.fell( dirX, dirZ );
		const T = tree.c.treeData, i = tree.i;
		if ( T.fallen[ i ] ) return;
		T.fallen[ i ] = 1;
		T.fall = T.fall || [];
		const axis = new THREE.Vector3( dirZ, 0, - dirX ).normalize(); // up x dir
		T.fall[ i ] = { axis, angle: 0 };
		this.falling.push( { T, i, c: tree.c, v: 0 } );
		if ( this.onTreeFall ) this.onTreeFall( T.h[ i ] );

	}

	animate( dt ) {

		if ( this.falling.length ) this.foliage.write();
		const m = new THREE.Matrix4();
		for ( let k = this.falling.length - 1; k >= 0; k -- ) {

			const f = this.falling[ k ];
			const st = f.T.fall[ f.i ];
			f.v += ( 1.2 + Math.sin( st.angle ) * 9 ) * dt;
			st.angle = Math.min( Math.PI / 2 - 0.08, st.angle + f.v * dt );
			const T = f.T, M = T.meshes;
			if ( M ) {

				const crown = T.conif[ f.i ] && T.h[ f.i ] >= BUSH ? M.crownC : M.crownD;
				crown.setMatrixAt( T.slot[ f.i ], this.treeMatrices( T, f.i, m, 'crown', st ) );
				M.trunks.setMatrixAt( f.i, this.treeMatrices( T, f.i, m, 'trunk', st ) );
				crown.instanceMatrix.needsUpdate = true;
				M.trunks.instanceMatrix.needsUpdate = true;

			}

			if ( st.angle >= Math.PI / 2 - 0.08 || ! f.c.alive ) this.falling.splice( k, 1 );

		}

	}

	// ---------- ortho textures ----------
	async retexture( c, z ) {

		c.texBusy = true;
		const px = z >= 13 ? 1024 : z === 12 ? 512 : 256;
		const canvas = await composeOrtho( z, c.rect.e0, c.rect.n0, c.rect.size, px, () => c.alive );
		c.texBusy = false;
		if ( ! c.alive ) return;
		const tex = new THREE.CanvasTexture( canvas );
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 8;
		const old = c.material.map;
		c.material.map = tex;
		c.material.needsUpdate = true;
		c.bmat.map = tex;
		c.bmat.needsUpdate = true;
		if ( old && old !== PLACEHOLDER ) old.dispose();
		c.texZ = z;

	}

	// high resolution (0.24 m/px) photo patches right around the car
	updatePatches( x, z ) {

		const tileM = RES0 / 2 ** NEAR_Z * 256;
		const E = x + ORIGIN_E, N = - z + ORIGIN_N;
		const tx = Math.floor( ( E - GRID_E ) / tileM ), ty = Math.floor( ( N - GRID_N ) / tileM );
		const want = new Set();
		const R = 3;
		for ( let dy = - R; dy <= R; dy ++ ) for ( let dx = - R; dx <= R; dx ++ ) {

			if ( dx * dx + dy * dy > ( R + 0.5 ) ** 2 ) continue;
			const key = ( tx + dx ) + '_' + ( ty + dy );
			want.add( key );
			if ( this.patches.has( key ) ) continue;
			const p = { alive: true, mesh: null };
			this.patches.set( key, p );
			const ptx = tx + dx, pty = ty + dy;
			const e0 = GRID_E + ptx * tileM, n0 = GRID_N + pty * tileM;
			Promise.all( [ loadTile( NEAR_Z, ptx, pty ), this.loadTerrain( ...this.tileKey( e0 + 1, n0 + 1 ) ), this.loadTerrain( ...this.tileKey( e0 + tileM - 1, n0 + tileM - 1 ) ) ] ).then( ( [ img ] ) => {

				if ( ! p.alive || ! img ) return;
				const n = 17, step = tileM / ( n - 1 );
				const g = new THREE.PlaneGeometry( 1, 1, n - 1, n - 1 );
				const pos = g.attributes.position, uv = g.attributes.uv;
				for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

					const k = j * n + i;
					const wx = e0 + i * step - ORIGIN_E, wz = - ( n0 + tileM - j * step - ORIGIN_N );
					pos.setXYZ( k, wx, this.visGround( wx, wz ) + 0.02, wz );
					uv.setXY( k, i / ( n - 1 ), 1 - j / ( n - 1 ) );

				}

				const tex = new THREE.Texture( img );
				tex.colorSpace = THREE.SRGBColorSpace;
				tex.anisotropy = 8;
				tex.needsUpdate = true;
				const mat = groundMaterial( - 2 );
				mat.map = tex;
				p.mesh = new THREE.Mesh( g, mat );
				p.mesh.userData.lift = 0.02;
				p.mesh.renderOrder = 1;
				this.group.add( p.mesh );

			} );

		}

		for ( const [ key, p ] of this.patches ) {

			if ( want.has( key ) ) continue;
			p.alive = false;
			this.patches.delete( key );
			if ( p.mesh ) { this.group.remove( p.mesh ); p.mesh.geometry.dispose(); p.mesh.material.map.dispose(); p.mesh.material.dispose(); }

		}

	}

	unload( key, c ) {

		c.alive = false;
		this.chunks.delete( key );
		if ( c.ground ) { this.group.remove( c.ground ); c.ground.geometry.dispose(); }
		if ( c.bld ) { this.group.remove( c.bld ); c.bld.geometry.disposeBoundsTree(); c.bld.geometry.dispose(); }
		if ( c.trees ) { this.group.remove( c.trees ); c.trees.children.forEach( m => m.dispose() ); }
		if ( c.material.map && c.material.map !== PLACEHOLDER ) c.material.map.dispose();
		c.material.dispose();
		c.bmat.dispose();

	}

	// ---------- queries ----------
	nearMeshes( x, z ) {

		const [ cx, cy ] = this.chunkOf( x, z );
		const out = [];
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const c = this.chunks.get( ( cx + dx ) + '_' + ( cy + dy ) );
			if ( c && c.bld ) out.push( c.bld );

		}

		return out;

	}

	raycast( origin, dir, far ) {

		const ray = new THREE.Raycaster( origin, dir, 0, far );
		ray.firstHitOnly = true;
		let best = null;
		for ( const m of this.nearMeshes( origin.x, origin.z ) ) {

			const h = ray.intersectObject( m, false );
			if ( h.length && ( ! best || h[ 0 ].distance < best.distance ) ) best = h[ 0 ];

		}

		return best;

	}

	closest( p, maxD, target ) {

		let best = null;
		for ( const m of this.nearMeshes( p.x, p.z ) ) {

			const r = m.geometry.boundsTree.closestPointToPoint( p, {}, 0, best ? best.distance : maxD );
			if ( r && r.distance < maxD && ( ! best || r.distance < best.distance ) ) best = { point: r.point.clone(), distance: r.distance };

		}

		if ( best && target ) target.copy( best.point );
		return best;

	}

}

const DOWN = new THREE.Vector3( 0, - 1, 0 );
