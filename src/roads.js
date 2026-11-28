import * as THREE from 'three';
import { ParkedCars } from './parked.js';
import { StreetNames } from './streetnames.js';
import { models, LENS, LENS_Z } from './props.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ORIGIN_E, ORIGIN_N } from './world.js';

const PIER = new THREE.BoxGeometry( 1, 1, 1 );

// Streets drawn from OpenStreetMap: asphalt, pavements, kerbs, lane markings, zebra crossings,
// parking lots, plus street furniture (lamps, traffic lights, bus shelters, speed cameras, signs, benches, bins).
// Everything is draped on the terrain and kept crisp up close (world-space tiling textures).

// ---------- procedural tiling textures ----------
function canvasTex( size, repeatM, draw ) {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	draw( c.getContext( '2d' ), size );
	const t = new THREE.CanvasTexture( c );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 8;
	t.userData.repeatM = repeatM;
	return t;

}

function noise( ctx, s, base, amp, n, sizeMax = 2 ) {

	ctx.fillStyle = base;
	ctx.fillRect( 0, 0, s, s );
	for ( let i = 0; i < n; i ++ ) {

		const v = ( Math.random() - 0.5 ) * amp;
		ctx.fillStyle = v > 0 ? `rgba(255,255,255,${ v / 255 })` : `rgba(0,0,0,${ - v / 255 })`;
		const r = Math.random() * sizeMax + 0.5;
		ctx.fillRect( Math.random() * s, Math.random() * s, r, r );

	}

}

const TEX = {};
function textures() {

	if ( TEX.asphalt ) return TEX;
	TEX.asphalt = canvasTex( 512, 4, ( x, s ) => {

		noise( x, s, '#5c5e62', 55, 30000, 1.8 );
		// faint patches and cracks
		for ( let i = 0; i < 6; i ++ ) {

			x.fillStyle = `rgba(0,0,0,${ 0.012 + Math.random() * 0.018 })`;
			x.beginPath();
			x.ellipse( Math.random() * s, Math.random() * s, 40 + Math.random() * 90, 20 + Math.random() * 60, Math.random() * 3, 0, 7 );
			x.fill();

		}

		x.strokeStyle = 'rgba(25,25,25,0.35)';
		x.lineWidth = 1.2;
		for ( let i = 0; i < 3; i ++ ) {

			x.beginPath();
			let px = Math.random() * s, py = Math.random() * s;
			x.moveTo( px, py );
			for ( let k = 0; k < 8; k ++ ) { px += ( Math.random() - 0.5 ) * 50; py += ( Math.random() - 0.3 ) * 40; x.lineTo( px, py ); }
			x.stroke();

		}

	} );
	TEX.paving = canvasTex( 512, 2.4, ( x, s ) => {

		noise( x, s, '#a9a69f', 40, 9000, 1.5 );
		const k = s / 8; // 0.3 m slabs
		for ( let i = 0; i < 8; i ++ ) for ( let j = 0; j < 8; j ++ ) {

			x.fillStyle = `rgba(${ Math.random() < 0.5 ? '0,0,0' : '255,255,255' },${ Math.random() * 0.06 })`;
			x.fillRect( i * k, j * k, k, k );

		}

		x.strokeStyle = 'rgba(60,58,54,0.55)';
		x.lineWidth = 2;
		for ( let i = 0; i <= 8; i ++ ) {

			x.beginPath(); x.moveTo( i * k, 0 ); x.lineTo( i * k, s ); x.stroke();
			x.beginPath(); x.moveTo( 0, i * k ); x.lineTo( s, i * k ); x.stroke();

		}

	} );
	TEX.cobble = canvasTex( 512, 2, ( x, s ) => {

		noise( x, s, '#6d6861', 30, 3000, 1 );
		const k = s / 12;
		for ( let j = 0; j < 12; j ++ ) for ( let i = 0; i < 12; i ++ ) {

			const g = 110 + Math.random() * 60;
			x.fillStyle = `rgb(${ g },${ g * 0.95 },${ g * 0.88 })`;
			x.beginPath();
			x.ellipse( ( i + ( j % 2 ) * 0.5 ) * k, j * k + k / 2, k * 0.44, k * 0.4, 0, 0, 7 );
			x.fill();

		}

	} );
	TEX.gravel = canvasTex( 256, 3, ( x, s ) => noise( x, s, '#8b8170', 90, 9000, 2.5 ) );
	TEX.white = new THREE.Color( 0xf0f0ea );
	return TEX;

}

function surfaceMat( tex, factor, units ) {

	return new THREE.MeshLambertMaterial( { map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: units } );

}

// ---------- draped mesh builder ----------
class Builder {

	constructor( world, repeatM ) {

		this.w = world; this.rep = repeatM;
		this.p = []; this.uv = []; this.i = [];

	}

	v( x, z, lift, yAt ) {

		const y = typeof yAt === 'number' ? yAt : yAt ? yAt( x, z ) : this.w.heightSmooth( x, z );
		this.p.push( x, y + lift, z );
		this.uv.push( x / this.rep, z / this.rep );
		return this.p.length / 3 - 1;

	}

	quad( a, b, c, d ) { this.i.push( a, b, c, a, c, d ); }

	// strip between lateral offsets o0..o1 (left positive) along a polyline [[x,z],...]
	strip( pts, o0, o1, lift, step = 4, yAt = null ) {

		const n = pts.length;
		if ( n < 2 ) return;
		const L = [], R = [];
		for ( let k = 0; k < n; k ++ ) {

			const a = pts[ Math.max( 0, k - 1 ) ], b = pts[ k ], c = pts[ Math.min( n - 1, k + 1 ) ];
			let d1x = b[ 0 ] - a[ 0 ], d1z = b[ 1 ] - a[ 1 ], d2x = c[ 0 ] - b[ 0 ], d2z = c[ 1 ] - b[ 1 ];
			const l1 = Math.hypot( d1x, d1z ) || 1, l2 = Math.hypot( d2x, d2z ) || 1;
			d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
			if ( k === 0 ) { d1x = d2x; d1z = d2z; }
			if ( k === n - 1 ) { d2x = d1x; d2z = d1z; }
			// left normal of direction (dx,dz) in x-east/z-south frame is (dz, -dx)
			let nx = d1z + d2z, nz = - d1x - d2x;
			const nl = Math.hypot( nx, nz ) || 1;
			nx /= nl; nz /= nl;
			const miter = Math.min( 2, 1 / Math.max( 0.3, nx * d1z - nz * d1x ) );
			L.push( [ b[ 0 ] + nx * o1 * miter, b[ 1 ] + nz * o1 * miter ] );
			R.push( [ b[ 0 ] + nx * o0 * miter, b[ 1 ] + nz * o0 * miter ] );

		}

		const ys = Array.isArray( yAt ) ? yAt : null;
		const Y = ( k, t ) => ys ? ys[ k ] + ( ys[ Math.min( n - 1, k + 1 ) ] - ys[ k ] ) * t : yAt;
		let pl = this.v( L[ 0 ][ 0 ], L[ 0 ][ 1 ], lift, Y( 0, 0 ) ), pr = this.v( R[ 0 ][ 0 ], R[ 0 ][ 1 ], lift, Y( 0, 0 ) );
		for ( let k = 0; k + 1 < n; k ++ ) {

			const len = Math.hypot( pts[ k + 1 ][ 0 ] - pts[ k ][ 0 ], pts[ k + 1 ][ 1 ] - pts[ k ][ 1 ] );
			const m = Math.max( 1, Math.ceil( len / step ) );
			for ( let s = 1; s <= m; s ++ ) {

				const t = s / m;
				const ql = this.v( L[ k ][ 0 ] + ( L[ k + 1 ][ 0 ] - L[ k ][ 0 ] ) * t, L[ k ][ 1 ] + ( L[ k + 1 ][ 1 ] - L[ k ][ 1 ] ) * t, lift, Y( k, t ) );
				const qr = this.v( R[ k ][ 0 ] + ( R[ k + 1 ][ 0 ] - R[ k ][ 0 ] ) * t, R[ k ][ 1 ] + ( R[ k + 1 ][ 1 ] - R[ k ][ 1 ] ) * t, lift, Y( k, t ) );
				this.quad( pr, pl, ql, qr );
				pl = ql; pr = qr;

			}

		}

	}

	// vertical wall along a polyline at lateral offset off (left positive), from y+h0 to y+h1
	wall( pts, off, ys, h0, h1 ) {

		for ( let k = 0; k + 1 < pts.length; k ++ ) {

			const [ ax, az ] = pts[ k ], [ bx, bz ] = pts[ k + 1 ];
			const l = Math.hypot( bx - ax, bz - az ) || 1, nx = ( bz - az ) / l, nz = - ( bx - ax ) / l;
			const a0 = this.v( ax + nx * off, az + nz * off, h0, ys[ k ] ), a1 = this.v( ax + nx * off, az + nz * off, h1, ys[ k ] );
			const b0 = this.v( bx + nx * off, bz + nz * off, h0, ys[ k + 1 ] ), b1 = this.v( bx + nx * off, bz + nz * off, h1, ys[ k + 1 ] );
			this.quad( a0, b0, b1, a1 );

		}

	}

	disc( x, z, r, lift, seg = 14, yAt = null ) {

		const c = this.v( x, z, lift, yAt );
		const first = this.p.length / 3;
		for ( let k = 0; k < seg; k ++ ) this.v( x + Math.cos( k / seg * 6.283 ) * r, z + Math.sin( k / seg * 6.283 ) * r, lift, yAt );
		for ( let k = 0; k < seg; k ++ ) this.i.push( c, first + ( k + 1 ) % seg, first + k );

	}

	// rectangle centred at (x,z), half sizes along (ax,az) and across
	rect( x, z, ax, az, ha, hc, lift ) {

		const cx = az, cz = - ax;
		const a = this.v( x + ax * ha + cx * hc, z + az * ha + cz * hc, lift );
		const b = this.v( x + ax * ha - cx * hc, z + az * ha - cz * hc, lift );
		const c = this.v( x - ax * ha - cx * hc, z - az * ha - cz * hc, lift );
		const d = this.v( x - ax * ha + cx * hc, z - az * ha + cz * hc, lift );
		this.quad( a, b, c, d );

	}

	polygon( flat, lift ) {

		const pts = [];
		for ( let k = 0; k < flat.length; k += 2 ) pts.push( new THREE.Vector2( flat[ k ], flat[ k + 1 ] ) );
		if ( pts.length < 3 ) return;
		const tris = THREE.ShapeUtils.triangulateShape( pts, [] );
		// split big triangles so the area follows the terrain instead of floating over it
		const P = pts.map( p => [ p.x, p.y ] ), key = new Map(), idx = [];
		const vid = ( a ) => {

			const k = a[ 0 ].toFixed( 2 ) + ',' + a[ 1 ].toFixed( 2 );
			let i = key.get( k );
			if ( i === undefined ) { i = this.v( a[ 0 ], a[ 1 ], lift ); key.set( k, i ); }
			return i;

		};

		const mid = ( a, b ) => [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2 ];
		const d2 = ( a, b ) => ( a[ 0 ] - b[ 0 ] ) ** 2 + ( a[ 1 ] - b[ 1 ] ) ** 2;
		const split = ( a, b, c, depth ) => {

			const ab = d2( a, b ), bc = d2( b, c ), ca = d2( c, a ), m = Math.max( ab, bc, ca );
			if ( m < 36 || depth > 9 || idx.length > 60000 ) { idx.push( vid( a ), vid( c ), vid( b ) ); return; }
			if ( m === ab ) { const q = mid( a, b ); split( a, q, c, depth + 1 ); split( q, b, c, depth + 1 ); }
			else if ( m === bc ) { const q = mid( b, c ); split( a, b, q, depth + 1 ); split( a, q, c, depth + 1 ); }
			else { const q = mid( c, a ); split( a, b, q, depth + 1 ); split( q, b, c, depth + 1 ); }

		};

		for ( const t of tris ) split( P[ t[ 0 ] ], P[ t[ 1 ] ], P[ t[ 2 ] ], 0 );
		for ( const i of idx ) this.i.push( i );

	}

	mesh( mat, order ) {

		if ( ! this.i.length ) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.p, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( this.uv, 2 ) );
		g.setIndex( this.i );
		g.computeVertexNormals();
		g.computeBoundingSphere();
		const m = new THREE.Mesh( g, mat );
		m.renderOrder = order;
		return m;

	}

}

// resample a polyline at ~1 m and return the runs where keep(x, z, s) is true
function runs( pts, keep, step = 1 ) {

	const out = [];
	let cur = null, s = 0;
	for ( let k = 0; k + 1 < pts.length; k ++ ) {

		const [ ax, az ] = pts[ k ], [ bx, bz ] = pts[ k + 1 ];
		const len = Math.hypot( bx - ax, bz - az );
		const m = Math.max( 1, Math.ceil( len / step ) );
		for ( let i = ( k === 0 ? 0 : 1 ); i <= m; i ++ ) {

			const t = i / m, x = ax + ( bx - ax ) * t, z = az + ( bz - az ) * t;
			const ss = s + len * t;
			if ( keep( x, z, ss ) ) {

				if ( ! cur ) { cur = []; out.push( cur ); }
				cur.push( [ x, z ] );

			} else cur = null;

		}

		s += len;

	}

	return out.filter( r => r.length > 1 );

}

export const SEA_LEVEL = 0.0;
const WATER_GEO = new THREE.PlaneGeometry( 250, 250, 1, 1 ).rotateX( - Math.PI / 2 );
// water: dark green-blue, glossy, with small moving ripples; the mask texture cuts out the shore
function waterMaterial( mask, time, env ) {

	const m = new THREE.MeshStandardMaterial( { color: 0x23424c, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.88, alphaMap: mask, alphaTest: 0.5, envMap: env || null, envMapIntensity: 0.9, depthWrite: true } );
	m.onBeforeCompile = s => {

		s.uniforms.uTime = time;
		s.vertexShader = s.vertexShader.replace( '#include <common>', '#include <common>\nvarying vec3 vWp;' ).replace( '#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;' );
		s.fragmentShader = s.fragmentShader
			.replace( '#include <common>', '#include <common>\nvarying vec3 vWp;\nuniform float uTime;' )
			.replace( '#include <normal_fragment_begin>', `#include <normal_fragment_begin>
				vec2 q = vWp.xz;
				float a = sin( q.x * 0.71 + q.y * 0.23 + uTime * 1.3 ) + sin( q.y * 1.13 - q.x * 0.31 - uTime * 1.1 ) + 0.5 * sin( q.x * 2.37 + q.y * 1.61 + uTime * 2.1 ) + 0.3 * sin( q.x * 4.1 - q.y * 3.3 - uTime * 2.9 );
				float b = cos( q.x * 1.07 - q.y * 0.37 - uTime * 1.2 ) + cos( q.y * 0.83 + q.x * 0.41 + uTime * 1.4 ) + 0.5 * cos( q.x * 1.9 - q.y * 2.6 + uTime * 1.9 ) + 0.3 * cos( q.y * 4.3 + q.x * 2.9 + uTime * 3.1 );
				float fade = 1.0 / ( 1.0 + length( vViewPosition ) * 0.02 ); // calmer far away, no moire
				normal = normalize( normal + ( viewMatrix * vec4( a * 0.018 * fade, 0.0, b * 0.018 * fade, 0.0 ) ).xyz );` );

	};

	return m;

}
const DIM = 0.13;

export class Roads {

	constructor( world ) {

		this.world = world;
		this.group = new THREE.Group();
		world.group.add( this.group );
		world.props = this;
		world.roads = this;
		this.chunks = new Map();
		this.falling = [];
		this.t = 0;
		this.radius = 2;
		this.onPropFall = null;
		this.parked = new ParkedCars( this );
		this.names = new StreetNames( this );
		const T = textures();
		this.mats = {
			// small offsets only: a large polygon offset pulls the street in front of the wheels at low camera angles
			asphalt: surfaceMat( T.asphalt, - 0.5, - 4 ),
			parking: surfaceMat( T.asphalt, - 0.25, - 3 ),
			paving: surfaceMat( T.paving, - 0.5, - 3 ),
			cobble: surfaceMat( T.cobble, - 0.5, - 4 ),
			gravel: surfaceMat( T.gravel, - 0.25, - 2 ),
			kerb: new THREE.MeshLambertMaterial( { color: 0xb9b7b0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: - 0.5, polygonOffsetUnits: - 4 } ),
			mark: new THREE.MeshLambertMaterial( { color: 0xf3f3ee, side: THREE.DoubleSide, emissive: 0x303030, polygonOffset: true, polygonOffsetFactor: - 1, polygonOffsetUnits: - 8 } ),
		};
		this.mats.parking.color.setHex( 0xe6e6e6 );
		this.mats.rail = new THREE.MeshLambertMaterial( { color: 0xc4c8cc, emissive: 0x2a2c2e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: - 1, polygonOffsetUnits: - 8 } );
		this.mats.sleeper = new THREE.MeshLambertMaterial( { color: 0x5b4b3d, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: - 0.5, polygonOffsetUnits: - 4 } );
		this.time = { value: 0 };

	}

	update( x, z ) {

		const man = this.world.manifest;
		if ( ! man || ! man.osmChunks ) return;
		const has = this.has || ( this.has = new Set( man.osmChunks.map( c => c[ 0 ] + '_' + c[ 1 ] ) ) );
		const [ cx, cy ] = this.world.chunkOf( x, z );
		const keep = new Set();
		const R = this.radius;
		for ( let dy = - R; dy <= R; dy ++ ) for ( let dx = - R; dx <= R; dx ++ ) {

			const key = ( cx + dx ) + '_' + ( cy + dy );
			if ( ! has.has( key ) ) continue;
			keep.add( key );
			if ( ! this.chunks.has( key ) ) this.load( key );

		}

		for ( const [ key, c ] of this.chunks ) if ( ! keep.has( key ) ) {

			const [ a, b ] = key.split( '_' ).map( Number );
			if ( Math.max( Math.abs( a - cx ), Math.abs( b - cy ) ) > R + 1 ) this.unload( key, c );

		}

	}

	load( key ) {

		const c = { key, alive: true, group: null, props: [], signals: [] };
		const man = this.world.manifest, [ kx, ky ] = key.split( '_' ).map( Number );
		c.e0 = man.gridE + kx * man.chunk; c.n0 = man.gridN + ky * man.chunk;
		this.chunks.set( key, c );
		const tryBuild = () => {

			// terrain under the chunk must be loaded so the streets sit on the ground
			if ( ! c.alive ) return;
			const [ cx, cy ] = key.split( '_' ).map( Number );
			const man = this.world.manifest;
			const e = man.gridE + cx * man.chunk + 125, n = man.gridN + cy * man.chunk + 125;
			this.world.loadTerrain( ...this.world.tileKey( e, n ) ).then( () => c.alive && this.build( c, c.data ) );

		};

		this.names.load( c );
		fetch( `./city/o_${key}.json` ).then( r => r.json() ).then( d => { c.data = d; tryBuild(); } ).catch( () => {} );
		return c;

	}

	build( c, d ) {

		const W = this.world, key = c.key;
		const g = new THREE.Group();
		const B = {
			asphalt: new Builder( W, 4 ), parking: new Builder( W, 4 ), paving: new Builder( W, 2.4 ), cobble: new Builder( W, 2 ),
			gravel: new Builder( W, 3 ), kerb: new Builder( W, 1 ), mark: new Builder( W, 1 ),
			rail: new Builder( W, 1 ), sleeper: new Builder( W, 1 ),
		};
		// junction lookup (this chunk); markings and kerbs stop short of junctions
		const J = d.j || [];
		const nearJ = ( x, z, pad ) => {

			for ( let k = 0; k < J.length; k += 3 ) {

				const dx = J[ k ] - x, dz = J[ k + 1 ] - z, r = J[ k + 2 ] + pad;
				if ( dx * dx + dz * dz < r * r ) return true;

			}

			return false;

		};

		// 1 m raster of the drivable surface (grip and physics height) and of bridge decks
		const N = 250, ras = new Uint8Array( N * N ), ox = c.e0 - ORIGIN_E, oz = - ( c.n0 - ORIGIN_N );
		const cell = ( x, z ) => [ x - ox, oz - z ]; // metres east / north inside the chunk
		const fillSeg = ( ax, az, bx, bz, hw, code, deckA, deckB ) => {

			const [ ai, aj ] = cell( ax, az ), [ bi, bj ] = cell( bx, bz );
			const i0 = Math.max( 0, Math.floor( Math.min( ai, bi ) - hw ) ), i1 = Math.min( N - 1, Math.ceil( Math.max( ai, bi ) + hw ) );
			const j0 = Math.max( 0, Math.floor( Math.min( aj, bj ) - hw ) ), j1 = Math.min( N - 1, Math.ceil( Math.max( aj, bj ) + hw ) );
			const dx = bi - ai, dy = bj - aj, l2 = dx * dx + dy * dy || 1;
			for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

				const px = i + 0.5, py = j + 0.5;
				const t = Math.max( 0, Math.min( 1, ( ( px - ai ) * dx + ( py - aj ) * dy ) / l2 ) );
				const ex = ai + dx * t - px, ey = aj + dy * t - py;
				if ( ex * ex + ey * ey > hw * hw ) continue;
				const k = j * N + i;
				if ( deckA !== undefined ) { ( c.deck || ( c.deck = new Float32Array( N * N ).fill( NaN ) ) )[ k ] = deckA + ( deckB - deckA ) * t; continue; }
				if ( ras[ k ] === 0 || code === 1 ) ras[ k ] = code;

			}

		};

		const fillPoly = ( flat, code ) => {

			let i0 = N, i1 = 0, j0 = N, j1 = 0;
			const P = [];
			for ( let k = 0; k < flat.length; k += 2 ) { const q = cell( flat[ k ], flat[ k + 1 ] ); P.push( q ); i0 = Math.min( i0, q[ 0 ] ); i1 = Math.max( i1, q[ 0 ] ); j0 = Math.min( j0, q[ 1 ] ); j1 = Math.max( j1, q[ 1 ] ); }
			for ( let j = Math.max( 0, Math.floor( j0 ) ); j <= Math.min( N - 1, Math.ceil( j1 ) ); j ++ ) for ( let i = Math.max( 0, Math.floor( i0 ) ); i <= Math.min( N - 1, Math.ceil( i1 ) ); i ++ ) {

				const px = i + 0.5, py = j + 0.5;
				let inside = false;
				for ( let a = 0, b = P.length - 1; a < P.length; b = a ++ ) {

					if ( ( P[ a ][ 1 ] > py ) !== ( P[ b ][ 1 ] > py ) && px < ( P[ b ][ 0 ] - P[ a ][ 0 ] ) * ( py - P[ a ][ 1 ] ) / ( P[ b ][ 1 ] - P[ a ][ 1 ] ) + P[ a ][ 0 ] ) inside = ! inside;

				}

				if ( inside && ( ras[ j * N + i ] === 0 || code === 1 ) ) ras[ j * N + i ] = code;

			}

		};

		// areas first (parking, squares, traffic islands)
		for ( const [ type, flat ] of d.a || [] ) {

			if ( type === 0 ) { B.parking.polygon( flat, 0.05 ); fillPoly( flat, 1 ); }
			else if ( type === 1 ) { B.paving.polygon( flat, 0.06 ); fillPoly( flat, 2 ); }
			else B.paving.polygon( flat, 0.16 );

		}

		// bridge decks: deck, parapets, underside and piers
		const piers = [];
		for ( const [ kind, width, , , flat ] of d.d || [] ) {

			const pts = [], ys = [];
			for ( let k = 0; k < flat.length; k += 3 ) { pts.push( [ flat[ k ], flat[ k + 1 ] ] ); ys.push( flat[ k + 2 ] ); }
			const hw = width / 2;
			( kind >= 4 ? B.paving : B.asphalt ).strip( pts, - hw, hw, 0, 3, ys );
			B.kerb.strip( pts, - hw - 0.35, hw + 0.35, - 0.9, 4, ys );
			for ( const side of [ - 1, 1 ] ) {

				B.kerb.wall( pts, side * ( hw + 0.2 ), ys, 0, 0.95 );
				B.kerb.wall( pts, side * ( hw + 0.35 ), ys, - 0.9, 0.95 );
				B.kerb.strip( pts, side * ( hw + 0.2 ) - 0.15, side * ( hw + 0.2 ) + 0.15, 0.95, 4, ys );

			}

			for ( let k = 0; k + 1 < pts.length; k ++ ) {

				fillSeg( pts[ k ][ 0 ], pts[ k ][ 1 ], pts[ k + 1 ][ 0 ], pts[ k + 1 ][ 1 ], hw + 0.3, 0, ys[ k ], ys[ k + 1 ] );
				const L = Math.hypot( pts[ k + 1 ][ 0 ] - pts[ k ][ 0 ], pts[ k + 1 ][ 1 ] - pts[ k ][ 1 ] );
				for ( let s = 12; s < L; s += 24 ) {

					const t = s / L, x = pts[ k ][ 0 ] + ( pts[ k + 1 ][ 0 ] - pts[ k ][ 0 ] ) * t, z = pts[ k ][ 1 ] + ( pts[ k + 1 ][ 1 ] - pts[ k ][ 1 ] ) * t;
					const top = ys[ k ] + ( ys[ k + 1 ] - ys[ k ] ) * t - 0.9, bot = W.height( x, z ) - 0.5;
					if ( top - bot > 1.5 ) piers.push( x, z, bot, top, Math.atan2( pts[ k + 1 ][ 0 ] - pts[ k ][ 0 ], pts[ k + 1 ][ 1 ] - pts[ k ][ 1 ] ), width );

				}

			}

		}

		for ( const w of d.w || [] ) {

			const [ kind, width, lanes, oneway, bridge, side, surf, flat ] = w, lanesF = w[ 8 ] || 0;
			const pts = [];
			for ( let k = 0; k < flat.length; k += 2 ) pts.push( [ flat[ k ], flat[ k + 1 ] ] );
			const hw = width / 2;
			const yAt = null;
			const code = kind >= 4 ? ( kind === 5 || surf === 2 ? 3 : surf === 1 ? 4 : kind === 6 ? 1 : 2 ) : ( surf === 1 ? 4 : surf === 2 ? 3 : 1 );
			for ( let k = 0; k + 1 < pts.length; k ++ ) fillSeg( pts[ k ][ 0 ], pts[ k ][ 1 ], pts[ k + 1 ][ 0 ], pts[ k + 1 ][ 1 ], hw + ( kind >= 4 ? 0 : 0.25 ), code );
			if ( kind >= 4 ) {

				// footways, cycleways, paths, tracks
				const b = kind === 5 || surf === 2 ? B.gravel : surf === 1 ? B.cobble : kind === 6 ? B.asphalt : B.paving;
				b.strip( pts, - hw, hw, bridge ? 0.08 : 0.06, 4, yAt );
				continue;

			}

			( surf === 1 ? B.cobble : surf === 2 ? B.gravel : B.asphalt ).strip( pts, - hw, hw, 0.07, 4, yAt );
			if ( kind === 3 || bridge ) continue;
			// kerbs and tagged pavements, cut back at junctions
			const free = runs( pts, ( x, z ) => ! nearJ( x, z, 1.5 ) );
			for ( const r of free ) {

				B.kerb.strip( r, hw, hw + 0.25, 0.064, 2 );
				B.kerb.strip( r, - hw - 0.25, - hw, 0.064, 2 );
				if ( side & 1 ) B.paving.strip( r, hw + 0.25, hw + 2.6, 0.062, 3 );
				if ( side & 2 ) B.paving.strip( r, - hw - 2.6, - hw - 0.25, 0.062, 3 );

			}

			// lane markings. Lane widths follow the lane count; with lanes:forward / lanes:backward tagged the
			// centre line sits between the two directions (right-hand traffic: forward lanes on the right).
			if ( surf || width < 4.6 ) continue;
			const L = Math.max( 1, lanes );
			const lw = 0.13;
			const dashed = ( period, on ) => ( x, z, s ) => ( s % period ) < on && ! nearJ( x, z, 3 );
			const solid = ( x, z ) => ! nearJ( x, z, 3 );
			const line = ( off, keep, wd = lw ) => { for ( const r of runs( pts, keep ) ) B.mark.strip( r, off - wd / 2, off + wd / 2, 0.075, 2 ); };
			if ( width < 5.5 ) {

				// small two-way street: a light dashed centre line
				if ( ! oneway ) line( 0, dashed( 6, 1.5 ), 0.1 );
				continue;

			}

			const laneW = width / L;
			if ( oneway ) {

				for ( let k = 1; k < L; k ++ ) line( - hw + laneW * k, dashed( 9, 3 ) );

			} else {

				if ( lanesF > 0 && lanesF < L ) {

					const mid = - hw + laneW * lanesF;
					if ( L >= 4 ) { line( mid - 0.12, solid ); line( mid + 0.12, solid ); } else line( mid, dashed( 9, 3 ) );
					for ( let k = 1; k < lanesF; k ++ ) line( - hw + laneW * k, dashed( 9, 3 ) );
					for ( let k = 1; k < L - lanesF; k ++ ) line( mid + laneW * k, dashed( 9, 3 ) );

				} else {

					const per = Math.max( 1, Math.floor( L / 2 ) );
					if ( L >= 4 ) { line( - 0.12, solid ); line( 0.12, solid ); } else line( 0, dashed( 9, 3 ) );
					for ( let k = 1; k < per; k ++ ) { line( hw * k / per, dashed( 9, 3 ) ); line( - hw * k / per, dashed( 9, 3 ) ); }

				}

			}

			if ( kind === 1 ) { line( hw - 0.35, solid ); line( - hw + 0.35, solid ); }

		}

		// junction caps (fill the corners of crossings)
		for ( let k = 0; k < J.length; k += 3 ) {

			B.asphalt.disc( J[ k ], J[ k + 1 ], J[ k + 2 ] + 0.4, 0.07 );
			fillSeg( J[ k ], J[ k + 1 ], J[ k ], J[ k + 1 ], J[ k + 2 ] + 0.4, 1 );

		}
		// zebra crossings: stripes parallel to the road, across its full width
		const X = d.x || [];
		for ( let k = 0; k < X.length; k += 4 ) {

			const x = X[ k ], z = X[ k + 1 ], yaw = X[ k + 2 ], w = X[ k + 3 ];
			const ax = Math.sin( yaw ), az = Math.cos( yaw );
			const n = Math.max( 2, Math.floor( ( w - 0.6 ) / 1.0 ) );
			for ( let s = 0; s < n; s ++ ) {

				const o = ( s - ( n - 1 ) / 2 ) * 1.0;
				B.mark.rect( x + az * o, z - ax * o, ax, az, 2.0, 0.25, 0.076 );

			}

		}

		// ---- railways and tram lines: rails you can see and feel ----
		const rails = [];
		for ( const piece of d.r || [] ) {

			const g = piece[ 0 ], street = piece[ 1 ], pts = [];
			for ( let k = 2; k + 1 < piece.length; k += 2 ) pts.push( [ piece[ k ], piece[ k + 1 ] ] );
			if ( pts.length < 2 ) continue;
			const hg = g / 2 + 0.036;
			if ( ! street ) {

				// ballast bed and sleepers
				B.gravel.strip( pts, - hg - 1.0, hg + 1.0, 0.085, 3 );
				for ( let k = 0; k + 1 < pts.length; k ++ ) fillSeg( pts[ k ][ 0 ], pts[ k ][ 1 ], pts[ k + 1 ][ 0 ], pts[ k + 1 ][ 1 ], hg + 1.0, 3 );
				for ( const r of runs( pts, ( x, z, sd ) => true, 0.65 ) ) for ( let k = 0; k + 1 < r.length; k ++ ) {

					const ax = r[ k + 1 ][ 0 ] - r[ k ][ 0 ], az = r[ k + 1 ][ 1 ] - r[ k ][ 1 ], l = Math.hypot( ax, az ) || 1;
					B.sleeper.rect( r[ k ][ 0 ], r[ k ][ 1 ], ax / l, az / l, 0.12, hg + 0.32, 0.12 );

				}

			}

			const top = street ? 0.085 : 0.2;
			for ( const sd of [ - 1, 1 ] ) B.rail.strip( pts, sd * hg - 0.036, sd * hg + 0.036, top, 2 );
			for ( let k = 0; k + 1 < pts.length; k ++ ) rails.push( pts[ k ][ 0 ], pts[ k ][ 1 ], pts[ k + 1 ][ 0 ], pts[ k + 1 ][ 1 ], hg, street );

		}

		if ( rails.length ) {

			// 8 m grid of rail segments for the bump under the wheels
			c.rails = rails;
			c.railGrid = new Map();
			for ( let q = 0; q < rails.length; q += 6 ) {

				const [ ax, az, bx, bz ] = rails.slice( q, q + 4 );
				for ( let gx = Math.floor( ( Math.min( ax, bx ) - 1 ) / 8 ); gx <= Math.floor( ( Math.max( ax, bx ) + 1 ) / 8 ); gx ++ ) for ( let gz = Math.floor( ( Math.min( az, bz ) - 1 ) / 8 ); gz <= Math.floor( ( Math.max( az, bz ) + 1 ) / 8 ); gz ++ ) {

					const k = gx + ',' + gz;
					if ( ! c.railGrid.has( k ) ) c.railGrid.set( k, [] );
					c.railGrid.get( k ).push( q );

				}

			}

		}

		const order = { parking: 1, gravel: 1, paving: 2, cobble: 2, asphalt: 3, kerb: 4, mark: 5, rail: 5, sleeper: 2 };
		for ( const k in B ) {

			const m = B[ k ].mesh( this.mats[ k ], order[ k ] );
			if ( m ) g.add( m );

		}

		this.buildProps( c, d.p || [], g, d.b || [] );
		this.parked.fill( c );
		if ( piers.length ) {

			const n = piers.length / 6, im = new THREE.InstancedMesh( PIER, this.mats.kerb, n ), m = new THREE.Matrix4(), q = new THREE.Quaternion();
			for ( let k = 0; k < n; k ++ ) {

				const [ x, z, b, t, yaw, w ] = piers.slice( k * 6, k * 6 + 6 );
				q.setFromAxisAngle( Y, yaw );
				im.setMatrixAt( k, m.compose( new THREE.Vector3( x, ( b + t ) / 2, z ), q, new THREE.Vector3( Math.min( 8, w * 0.7 ), t - b, 1.2 ) ) );

			}

			im.computeBoundingSphere();
			g.add( im );

		}

		c.surf = ras;
		this.buildWater( c, d.wt || [], ras, g );
		c.group = g;
		this.names.build( c );
		this.group.add( g );
		const wc = W.chunks.get( key );
		if ( wc ) W.cullTrees( wc );
		W.resinkGround( ox - 5, oz - N - 5, ox + N + 5, oz + 5 );

	}

	buildProps( c, P, g, B = [] ) {

		const M = models(), W = this.world;
		const byType = {};
		for ( let k = 0; k < P.length; k += 4 ) {

			const type = P[ k ];
			if ( ! M[ type ] ) continue;
			let x = P[ k + 1 ], z = P[ k + 2 ];
			const yaw = P[ k + 3 ];
			if ( type === 3 ) { x -= Math.sin( yaw ) * 1.4; z -= Math.cos( yaw ) * 1.4; } // shelter sits back from the kerb
			( byType[ type ] || ( byType[ type ] = [] ) ).push( { type, x, z, y: W.height( x, z ), yaw, h: M[ type ][ 1 ], r: M[ type ][ 2 ], fallen: false } );

		}

		for ( let k = 0; k < B.length; k += 5 ) {

			const type = B[ k ], x = B[ k + 1 ], z = B[ k + 2 ];
			( byType[ type ] || ( byType[ type ] = [] ) ).push( { type, x, z, y: W.height( x, z ), yaw: B[ k + 3 ], len: B[ k + 4 ], h: M[ type ][ 1 ], r: M[ type ][ 2 ], fallen: false } );

		}

		const m4 = new THREE.Matrix4();
		for ( const type in byType ) {

			const list = byType[ type ];
			const im = new THREE.InstancedMesh( M[ type ][ 0 ], M.mat, list.length );
			im.userData.sh = 1; // street furniture: no shadow casting (cheap shadow pass)
			list.forEach( ( p, i ) => {

				p.mesh = im; p.slot = i; p.chunk = c;
				p.fell = ( dx, dz ) => this.fell( p, dx, dz );
				im.setMatrixAt( i, this.matrix( p, m4 ) );
				c.props.push( p );

			} );
			im.computeBoundingSphere();
			g.add( im );
			if ( + type === 2 ) {

				const sig = list.concat( this.buildArms( c, list, g ) );
				c.signals = sig;
				c.lenses = LENS.map( ( [ y ] ) => {

					const lm = new THREE.InstancedMesh( M.lens, M.lensMat, sig.length );
					lm.userData.y = y;
					sig.forEach( ( p, i ) => lm.setMatrixAt( i, this.lensMatrix( p, y, m4 ) ) );
					lm.computeBoundingSphere();
					g.add( lm );
					return lm;

				} );
				this.colorSignals( c );

			}

		}

	}

	// Mast arms over the big roads (as on Tallinn's main streets): a light at the kerb of a road 9 m or wider
	// gets a taller pole with an arm reaching over its lanes and a second head hanging above them.
	// Returns the hanging heads, which join the chunk's signals (same phase as their pole).
	buildArms( c, list, g ) {

		const W = ( c.data && c.data.w ) || [], M = models(), heads = [], arms = [];
		for ( const p of list ) {

			let best = null;
			for ( const [ kind, width, , oneway, bridge, , , flat ] of W ) {

				if ( kind > 2 || bridge || width < 9 ) continue;
				for ( let k = 0; k + 2 < flat.length; k += 2 ) {

					const ax = flat[ k ], az = flat[ k + 1 ], dx = flat[ k + 2 ] - ax, dz = flat[ k + 3 ] - az, l2 = dx * dx + dz * dz || 1;
					const t = Math.max( 0, Math.min( 1, ( ( p.x - ax ) * dx + ( p.z - az ) * dz ) / l2 ) );
					const px = ax + dx * t, pz = az + dz * t, d = Math.hypot( p.x - px, p.z - pz );
					if ( d < width / 2 + 5 && ( ! best || d < best.d ) ) best = { d, px, pz, width, oneway };

				}

			}

			// at the kerb, not on an island in the middle of the road
			if ( ! best || best.d < best.width / 2 - 1 || best.d < 2 ) continue;
			const ux = ( best.px - p.x ) / best.d, uz = ( best.pz - p.z ) / best.d;
			const L = Math.max( 4, Math.min( 11, best.oneway ? best.d + best.width / 2 - 2 : best.d - 0.8 ) );
			// one arm per approach
			if ( arms.some( a => Math.hypot( a.x - p.x, a.z - p.z ) < 14 && a.ux * ux + a.uz * uz > 0.7 ) ) continue;
			arms.push( { x: p.x, z: p.z, y: p.y, ux, uz, L } );
			p.solid = true; p.h = 6; // a steel mast does not fall over
			for ( const f of L > 8 ? [ 0.45, 0.85 ] : [ 0.75 ] ) heads.push( { type: 2, head: true, x: p.x + ux * L * f, z: p.z + uz * L * f, y: p.y + 2.0, yaw: p.yaw, fallen: false } );

		}

		if ( ! arms.length ) return heads;
		const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
		const mast = new THREE.InstancedMesh( M.mast, M.mat, arms.length ), arm = new THREE.InstancedMesh( M.arm, M.mat, arms.length );
		arms.forEach( ( a, i ) => {

			mast.setMatrixAt( i, m4.compose( v.set( a.x, a.y, a.z ), q.identity(), ONE ) );
			arm.setMatrixAt( i, m4.compose( v.set( a.x, a.y + 5.9, a.z ), q.setFromAxisAngle( Y, Math.atan2( - a.uz, a.ux ) ), sc.set( a.L, 1, 1 ) ) );

		} );
		const hm = new THREE.InstancedMesh( M.head, M.mat, heads.length );
		heads.forEach( ( h, i ) => hm.setMatrixAt( i, this.matrix( h, m4 ) ) );
		for ( const im of [ mast, arm, hm ] ) { im.userData.sh = 1; im.computeBoundingSphere(); g.add( im ); }
		return heads;

	}

	matrix( p, m ) {

		const q = new THREE.Quaternion().setFromAxisAngle( Y, p.yaw );
		if ( p.fall ) q.premultiply( new THREE.Quaternion().setFromAxisAngle( p.fall.axis, p.fall.angle ) );
		return m.compose( new THREE.Vector3( p.x, p.y, p.z ), q, p.len ? SC.set( p.len * 1.02, 1, 1 ) : ONE );

	}

	lensMatrix( p, y, m ) {

		return this.matrix( p, m ).multiply( new THREE.Matrix4().makeTranslation( 0, y, LENS_Z ) );

	}

	// north-south and east-west approaches take turns: 10 s green, 3 s amber, then red
	colorSignals( c ) {

		if ( ! c.lenses ) return;
		const col = new THREE.Color();
		c.signals.forEach( ( p, i ) => {

			const grp = ( ( ( p.yaw % Math.PI ) + Math.PI ) % Math.PI ) < Math.PI / 4 || ( ( ( p.yaw % Math.PI ) + Math.PI ) % Math.PI ) > Math.PI * 0.75 ? 0 : 1;
			const t = ( this.t + grp * 13 ) % 26;
			const state = p.fallen ? - 1 : t < 10 ? 2 : t < 13 ? 1 : 0;
			LENS.forEach( ( [ , hex ], k ) => {

				col.setHex( hex );
				if ( k !== state ) col.multiplyScalar( DIM );
				c.lenses[ k ].setColorAt( i, col );

			} );

		} );
		for ( const l of c.lenses ) l.instanceColor.needsUpdate = true;

	}

	fell( p, dx, dz ) {

		if ( p.fallen ) return;
		p.fallen = true;
		p.fall = { axis: new THREE.Vector3( dz, 0, - dx ).normalize(), angle: 0, v: 0 };
		this.falling.push( p );
		if ( this.onPropFall ) this.onPropFall( p );

	}

	// ---- water: the sea (low terrain) and the lakes, ponds and rivers of OpenStreetMap ----
	buildWater( c, polys, ras, g ) {

		const N = 250, W = this.world, ox = c.e0 - ORIGIN_E, oz = - ( c.n0 - ORIGIN_N );
		const water = new Uint8Array( N * N ), levels = [];
		// sea: where the terrain model has no land (it is filled with -0.4 m there)
		let sea = false;
		for ( let j = 0; j < N; j += 1 ) for ( let i = 0; i < N; i += 1 ) {

			if ( W.heightRaw( ox + i + 0.5, oz - j - 0.5 ) < - 0.2 ) { water[ j * N + i ] = 1; sea = true; }

		}

		if ( sea ) levels.push( SEA_LEVEL );
		for ( const [ level, ...rings ] of polys ) {

			let li = levels.indexOf( level );
			if ( li < 0 ) { if ( levels.length >= 254 ) continue; levels.push( level ); li = levels.length - 1; }
			const R = rings.map( f => { const P = []; for ( let k = 0; k + 1 < f.length; k += 2 ) P.push( [ f[ k ] - ox, oz - f[ k + 1 ] ] ); return P; } );
			let i0 = N, i1 = 0, j0 = N, j1 = 0;
			for ( const P of R ) for ( const [ a, b ] of P ) { i0 = Math.min( i0, a ); i1 = Math.max( i1, a ); j0 = Math.min( j0, b ); j1 = Math.max( j1, b ); }
			for ( let j = Math.max( 0, Math.floor( j0 ) ); j <= Math.min( N - 1, Math.ceil( j1 ) ); j ++ ) {

				const py = j + 0.5;
				for ( let i = Math.max( 0, Math.floor( i0 ) ); i <= Math.min( N - 1, Math.ceil( i1 ) ); i ++ ) {

					const px = i + 0.5;
					let inside = false;
					for ( const P of R ) for ( let a = 0, b = P.length - 1; a < P.length; b = a ++ ) {

						if ( ( P[ a ][ 1 ] > py ) !== ( P[ b ][ 1 ] > py ) && px < ( P[ b ][ 0 ] - P[ a ][ 0 ] ) * ( py - P[ a ][ 1 ] ) / ( P[ b ][ 1 ] - P[ a ][ 1 ] ) + P[ a ][ 0 ] ) inside = ! inside;

					}

					if ( inside ) water[ j * N + i ] = li + 1;

				}

			}

		}

		if ( ! levels.length ) return;
		// streets and paths stay dry (bridge decks are drawn over the water)
		for ( let k = 0; k < N * N; k ++ ) if ( ras[ k ] ) water[ k ] = 0;
		c.water = water; c.levels = levels;
		levels.forEach( ( level, li ) => {

			const data = new Uint8Array( N * N * 4 );
			let any = false;
			for ( let k = 0; k < N * N; k ++ ) if ( water[ k ] === li + 1 ) { data[ k * 4 + 1 ] = 255; any = true; }
			if ( ! any ) return;
			const mask = new THREE.DataTexture( data, N, N );
			mask.magFilter = THREE.LinearFilter; mask.minFilter = THREE.LinearFilter; mask.needsUpdate = true;
			const m = new THREE.Mesh( WATER_GEO, waterMaterial( mask, this.time, this.env ) );
			m.position.set( ox + N / 2, level, oz - N / 2 );
			m.renderOrder = 7;
			m.userData.sh = 1;
			m.userData.water = true;
			g.add( m );

		} );

	}

	waterLevel( x, z ) {

		const r = this.rasterAt( x, z );
		if ( ! r || ! r[ 0 ].water ) return null;
		const v = r[ 0 ].water[ r[ 1 ] ];
		return v ? r[ 0 ].levels[ v - 1 ] : null;

	}

	// height of a rail head under (x, z): a short rounded ridge, so the car bumps over tram and train tracks
	railBump( x, z ) {

		const man = this.world.manifest;
		if ( ! man ) return 0;
		const E = x + ORIGIN_E, Nn = - z + ORIGIN_N;
		const c = this.chunks.get( Math.floor( ( E - man.gridE ) / man.chunk ) + '_' + Math.floor( ( Nn - man.gridN ) / man.chunk ) );
		if ( ! c || ! c.railGrid ) return 0;
		const L = c.railGrid.get( Math.floor( x / 8 ) + ',' + Math.floor( z / 8 ) );
		if ( ! L ) return 0;
		const R = c.rails;
		let h = 0;
		for ( const q of L ) {

			const ax = R[ q ], az = R[ q + 1 ], dx = R[ q + 2 ] - ax, dz = R[ q + 3 ] - az, l2 = dx * dx + dz * dz;
			if ( l2 < 1e-6 ) continue;
			const t = ( ( x - ax ) * dx + ( z - az ) * dz ) / l2;
			if ( t < - 0.02 || t > 1.02 ) continue;
			const d = Math.abs( ( ( x - ax ) * dz - ( z - az ) * dx ) / Math.sqrt( l2 ) );
			const dd = Math.abs( d - R[ q + 4 ] );
			if ( dd < 0.14 ) h = Math.max( h, ( R[ q + 5 ] ? 0.022 : 0.05 ) * 0.5 * ( 1 + Math.cos( Math.PI * dd / 0.14 ) ) );

		}

		return h;

	}

	rasterAt( x, z ) {

		const man = this.world.manifest;
		if ( ! man ) return null;
		const E = x + ORIGIN_E, Nn = - z + ORIGIN_N;
		const cx = Math.floor( ( E - man.gridE ) / man.chunk ), cy = Math.floor( ( Nn - man.gridN ) / man.chunk );
		const c = this.chunks.get( cx + '_' + cy );
		if ( ! c || ! c.surf ) return null;
		const i = Math.floor( E - c.e0 ), j = Math.floor( Nn - c.n0 );
		if ( i < 0 || j < 0 || i >= 250 || j >= 250 ) return null;
		return [ c, j * 250 + i ];

	}

	surface( x, z ) {

		const r = this.rasterAt( x, z );
		return r ? r[ 0 ].surf[ r[ 1 ] ] : 0;

	}

	deckY( x, z, yRef ) {

		const r = this.rasterAt( x, z );
		if ( ! r || ! r[ 0 ].deck ) return null;
		const v = r[ 0 ].deck[ r[ 1 ] ];
		if ( v !== v ) return null;
		// a deck counts only for a car near its level: under a viaduct the street below is the ground
		return yRef === undefined || yRef > v - 1.5 ? v : null;

	}

	near( x, z, r, out ) {

		const [ cx, cy ] = this.world.chunkOf( x, z );
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const c = this.chunks.get( ( cx + dx ) + '_' + ( cy + dy ) );
			if ( ! c ) continue;
			for ( const p of c.props ) {

				if ( p.fallen ) continue;
				const ddx = p.x - x, ddz = p.z - z;
				if ( ddx * ddx + ddz * ddz < r * r ) out.push( p );

			}

		}

	}

	animate( dt ) {

		this.t += dt;
		this.time.value += dt;
		const m = new THREE.Matrix4();
		for ( let k = this.falling.length - 1; k >= 0; k -- ) {

			const p = this.falling[ k ], f = p.fall;
			f.v += ( 2 + Math.sin( f.angle ) * 12 ) * dt;
			f.angle = Math.min( Math.PI / 2 - 0.04, f.angle + f.v * dt );
			p.mesh.setMatrixAt( p.slot, this.matrix( p, m ) );
			p.mesh.instanceMatrix.needsUpdate = true;
			if ( p.type === 2 ) {

				const c = p.chunk;
				if ( c && c.lenses ) for ( const l of c.lenses ) { l.setMatrixAt( p.slot, this.lensMatrix( p, l.userData.y, m ) ); l.instanceMatrix.needsUpdate = true; }

			}

			if ( f.angle >= Math.PI / 2 - 0.04 ) this.falling.splice( k, 1 );

		}

		this.sigT = ( this.sigT || 0 ) - dt;
		if ( this.sigT <= 0 ) {

			this.sigT = 0.25;
			for ( const c of this.chunks.values() ) this.colorSignals( c );

		}

	}

	unload( key, c ) {

		c.alive = false;
		this.parked.drop( c );
		this.names.drop( c );
		this.chunks.delete( key );
		if ( c.group ) {

			this.group.remove( c.group );
			c.group.traverse( o => {

				if ( o.userData.water ) { o.material.alphaMap.dispose(); o.material.dispose(); return; }
				if ( o.isMesh && ! o.isInstancedMesh ) o.geometry.dispose();
				if ( o.isInstancedMesh ) o.dispose();

			} );

		}

		this.falling = this.falling.filter( p => ! c.props.includes( p ) );

	}

}

const Y = new THREE.Vector3( 0, 1, 0 ), ONE = new THREE.Vector3( 1, 1, 1 ), SC = new THREE.Vector3();
