import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Low-poly cars built from real-car proportions (lengths, wheelbase, belt/roof lines, glasshouse):
//   rally   - 90s 4WD turbo rally sedan (GC8-era proportions): blue, yellow stripe, gold wheels, scoop, tall wing
//   touring - 90s boxy touring-car estate (850-era proportions): white race livery, splitter, tailgate spoiler
//   coupe   - 90s six-cylinder sports coupe (E36-era proportions): long bonnet, twin grille, quad lamps
// The body is a chain of cross-sections (stations) from rear to front, joined by flat-shaded quads.
// Model space: +Z forward, +X left, +Y up, ground at y=0; root origin is the centre of mass (0.56 up).
const GROUND = - 0.56;

const lin = keys => z => {

	if ( z <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ];
	for ( let i = 1; i < keys.length; i ++ ) if ( z <= keys[ i ][ 0 ] ) {

		const [ z0, a ] = keys[ i - 1 ], [ z1, b ] = keys[ i ];
		return a + ( b - a ) * ( z - z0 ) / ( z1 - z0 );

	}

	return keys[ keys.length - 1 ][ 1 ];

};
const inR = ( z, ranges ) => ranges.some( ( [ a, b ] ) => z >= a - 1e-4 && z <= b + 1e-4 );

const DEFS = {

	rally: {
		name: 'Rally 4WD', colors: [ 0x16389a, 0xc8102e, 0xf2f2f0, 0x1c1c20, 0x2b8a4c ], accent: 0xf6c800,
		zR: - 2.18, zF: 2.2, axle: [ 1.06, - 1.46 ], track: 0.753, tyreR: 0.32, archR: 0.4, sill: 0.24,
		belt: [ [ - 2.18, 0.8 ], [ - 2.12, 0.93 ], [ - 1.9, 0.98 ], [ - 1.42, 0.99 ], [ 0.85, 0.95 ], [ 1.6, 0.86 ], [ 2.06, 0.77 ], [ 2.2, 0.62 ] ],
		hw: [ [ - 2.18, 0.7 ], [ - 2.1, 0.8 ], [ - 1.95, 0.85 ], [ - 1.27, 0.885 ], [ - 0.7, 0.85 ], [ 0.7, 0.85 ], [ 1.28, 0.885 ], [ 1.95, 0.84 ], [ 2.12, 0.77 ], [ 2.2, 0.67 ] ],
		gh: [ - 1.42, 0.85 ], roof: [ [ - 1.42, 1.04 ], [ - 0.85, 1.37 ], [ 0.05, 1.4 ], [ 0.85, 1.01 ] ], hwR: [ [ - 1.42, 0.7 ], [ - 0.85, 0.63 ], [ 0.05, 0.63 ], [ 0.85, 0.71 ] ],
		topGlass: [ [ - 1.42, - 0.85 ], [ 0.05, 0.85 ] ], sideGlass: [ [ - 1.08, - 0.34 ], [ - 0.22, 0.78 ] ],
		stripe: 'upper', rim: 0xc9a13b, spokes: 5, extras: [ 'scoop', 'wing', 'fogs', 'flaps', 'vent' ], exhaust: [ [ - 0.5, 0.3 ] ],
		lights: { front: 'round', rear: 'wide' },
	},

	touring: {
		name: 'Touring FWD', colors: [ 0xf1f1ee, 0x10254f, 0xb81d24, 0x2a2c31, 0x1d5fa8 ], accent: 0x1d3f9c,
		zR: - 2.35, zF: 2.36, axle: [ 1.02, - 1.64 ], track: 0.735, tyreR: 0.32, archR: 0.4, sill: 0.15,
		belt: [ [ - 2.35, 0.95 ], [ - 2.3, 0.99 ], [ - 1.3, 0.99 ], [ 0.95, 0.95 ], [ 1.75, 0.84 ], [ 2.26, 0.78 ], [ 2.36, 0.62 ] ],
		hw: [ [ - 2.35, 0.84 ], [ - 2.28, 0.88 ], [ - 1.3, 0.895 ], [ 0, 0.87 ], [ 1.36, 0.895 ], [ 2.22, 0.87 ], [ 2.36, 0.8 ] ],
		gh: [ - 2.28, 0.95 ], roof: [ [ - 2.28, 1.36 ], [ - 2.2, 1.42 ], [ 0.25, 1.44 ], [ 0.95, 1.0 ] ], hwR: [ [ - 2.28, 0.75 ], [ - 2.2, 0.75 ], [ 0.25, 0.73 ], [ 0.95, 0.79 ] ],
		topGlass: [ [ - 2.35, - 2.28 ], [ 0.25, 0.95 ] ], sideGlass: [ [ - 2.14, - 1.42 ], [ - 1.3, - 0.32 ], [ - 0.2, 0.86 ] ],
		stripe: 'lower', rim: 0xe8e8e8, spokes: 6, extras: [ 'splitter', 'tailspoiler' ], exhaust: [ [ 0.55, 0.22 ] ],
		lights: { front: 'rect', rear: 'tall' },
	},

	coupe: {
		name: 'Coupé RWD', colors: [ 0xa8101a, 0x1c3f8c, 0xb5b9be, 0x18191c, 0xe8e8e4 ], accent: 0x111111,
		zR: - 2.2, zF: 2.24, axle: [ 1.26, - 1.31 ], track: 0.718, tyreR: 0.33, archR: 0.41, sill: 0.17,
		belt: [ [ - 2.2, 0.82 ], [ - 2.14, 0.92 ], [ - 1.95, 0.96 ], [ - 1.5, 0.97 ], [ 0.72, 0.92 ], [ 1.6, 0.82 ], [ 2.1, 0.74 ], [ 2.24, 0.6 ] ],
		hw: [ [ - 2.2, 0.72 ], [ - 2.12, 0.82 ], [ - 1.95, 0.86 ], [ - 1.35, 0.895 ], [ - 0.7, 0.86 ], [ 0.7, 0.86 ], [ 1.4, 0.895 ], [ 2.0, 0.86 ], [ 2.16, 0.78 ], [ 2.24, 0.69 ] ],
		gh: [ - 1.5, 0.72 ], roof: [ [ - 1.5, 1.02 ], [ - 0.95, 1.31 ], [ - 0.05, 1.34 ], [ 0.72, 0.97 ] ], hwR: [ [ - 1.5, 0.67 ], [ - 0.95, 0.63 ], [ - 0.05, 0.63 ], [ 0.72, 0.7 ] ],
		topGlass: [ [ - 1.5, - 0.95 ], [ - 0.05, 0.72 ] ], sideGlass: [ [ - 1.18, - 0.6 ], [ - 0.55, 0.62 ] ],
		stripe: null, rim: 0xc3c7cc, spokes: 10, extras: [ 'lip', 'kidney' ], exhaust: [ [ - 0.55, 0.2 ], [ - 0.42, 0.2 ], [ 0.42, 0.2 ], [ 0.55, 0.2 ] ],
		lights: { front: 'quad', rear: 'wide' },
	},

};

export const CAR_IDS = Object.keys( DEFS );

// Sketchfab models (prepared by scripts/models/build-cars.mjs): body + four wheels in this file's body frame
// (ground y = 0, +Z forward, +X left, wheel hubs at the physics axles). Until they arrive the procedural cars show.
//   rally   - "1998 Subaru Impreza 22B STi" by ddiaz-design
//   touring - "Volvo 850 T5 R Estate 1995" by szymonpasterczyk
//   coupe   - "BMW M3 Coupe (E30) 1986" by Lexyc16
const MODELS = {};
export const carModelsReady = ( async () => {

	const loader = new GLTFLoader();
	loader.setMeshoptDecoder( MeshoptDecoder );
	await Promise.all( CAR_IDS.map( async id => {

		try {

			const g = await loader.loadAsync( `./models/${id}.glb` );
			g.scene.traverse( o => { if ( o.isMesh ) { o.userData.shared = true; if ( o.material.map ) o.material.map.anisotropy = 8; } } );
			g.scene.updateMatrixWorld( true );
			MODELS[ id ] = g.scene;

		} catch ( e ) { console.warn( 'car model', id, e ); }

	} ) );
	return Object.keys( MODELS ).length;

} )();

// ---------- body ----------
function buildBody( D ) {

	const belt = lin( D.belt ), hw = lin( D.hw ), roof = lin( D.roof ), hwR = lin( D.hwR );
	const bot = z => {

		let y = D.sill;
		for ( const a of D.axle ) {

			const dz = Math.abs( z - a );
			if ( dz < D.archR + 1e-4 ) y = Math.max( y, D.tyreR - 0.02 + Math.sqrt( Math.max( 0, D.archR * D.archR - dz * dz ) ) * 0.95 );

		}

		return y;

	};

	// stations: every key position, glass/greenhouse edges and points around each wheel arch
	const zs = new Set();
	const add = z => { if ( z >= D.zR - 1e-6 && z <= D.zF + 1e-6 ) zs.add( Math.round( z * 1000 ) / 1000 ); };
	[ D.belt, D.hw, D.roof, D.hwR ].forEach( k => k.forEach( p => add( p[ 0 ] ) ) );
	[ ...D.topGlass, ...D.sideGlass ].forEach( r => { add( r[ 0 ] ); add( r[ 1 ] ); } );
	add( D.gh[ 0 ] ); add( D.gh[ 1 ] );
	for ( const a of D.axle ) for ( const t of [ - 1, - 0.97, - 0.8, - 0.5, - 0.2, 0.2, 0.5, 0.8, 0.97, 1 ] ) add( a + t * D.archR );
	for ( const a of D.axle ) { add( a - D.archR - 0.01 ); add( a + D.archR + 0.01 ); }
	const Z = [ ...zs ].sort( ( a, b ) => a - b );

	// cross-section (right side, x>0... mirrored later), bottom centre to roof centre
	const ring = z => {

		const b = bot( z ), bl = belt( z ), w = hw( z );
		const inGH = z >= D.gh[ 0 ] - 1e-4 && z <= D.gh[ 1 ] + 1e-4;
		const inner = Math.min( D.track - 0.17, w - 0.06 );
		const p = [ [ 0, D.sill + 0.02 ], [ inner, D.sill + 0.02 ], [ w - 0.03, b ], [ w, Math.min( b + 0.06, bl - 0.3 ) ], [ w, bl - 0.27 ], [ w, bl - 0.1 ], [ w - 0.025, bl ] ];
		if ( inGH ) {

			const r = roof( z ), wr = hwR( z );
			p.push( [ w - 0.07, bl + 0.03 ], [ wr, Math.max( bl + 0.04, r - 0.07 ) ], [ wr - 0.06, r - 0.005 ], [ 0, r ] );

		} else p.push( [ w - 0.1, bl + 0.025 ], [ w - 0.22, bl + 0.04 ], [ w - 0.34, bl + 0.05 ], [ 0, bl + 0.065 ] );
		return p;

	};

	// ring segment index -> part: 0 under, 1 liner, 2 rocker, 3 lower door, 4 upper door, 5 shoulder, 6 sill, 7 side window, 8 rail, 9 roof/top
	const part = ( z, s ) => {

		if ( s === 0 || s === 1 ) return 'black';
		if ( s === 2 ) return 'trim';
		if ( s === 3 ) return D.stripe === 'lower' ? 'accent' : 'paint';
		if ( s === 4 ) return D.stripe === 'upper' ? 'accent' : 'paint';
		if ( s === 7 ) return inR( z, D.sideGlass ) ? 'glass' : 'paint';
		if ( s === 9 ) return inR( z, D.topGlass ) ? 'glass' : 'paint';
		return 'paint';

	};

	const buf = { paint: [], accent: [], glass: [], black: [], trim: [] };
	const tri = ( m, a, b, c ) => buf[ m ].push( ...a, ...b, ...c );
	const rings = Z.map( z => ring( z ).map( ( [ x, y ] ) => [ x, y, z ] ) );
	for ( let i = 0; i + 1 < Z.length; i ++ ) {

		const A = rings[ i ], B = rings[ i + 1 ], zm = ( Z[ i ] + Z[ i + 1 ] ) / 2;
		for ( let s = 0; s + 1 < A.length; s ++ ) {

			const m = part( zm, s );
			for ( const sx of [ 1, - 1 ] ) {

				const a = [ A[ s ][ 0 ] * sx, A[ s ][ 1 ], A[ s ][ 2 ] ], b = [ A[ s + 1 ][ 0 ] * sx, A[ s + 1 ][ 1 ], A[ s + 1 ][ 2 ] ];
				const c = [ B[ s + 1 ][ 0 ] * sx, B[ s + 1 ][ 1 ], B[ s + 1 ][ 2 ] ], d = [ B[ s ][ 0 ] * sx, B[ s ][ 1 ], B[ s ][ 2 ] ];
				if ( sx > 0 ) { tri( m, a, c, d ); tri( m, a, b, c ); } else { tri( m, a, d, c ); tri( m, a, c, b ); }

			}

		}

	}

	// end caps (front and rear faces)
	for ( const [ R, front ] of [ [ rings[ 0 ], false ], [ rings[ rings.length - 1 ], true ] ] ) {

		const full = [ ...R.slice( 0, - 1 ), ...R.slice( 1 ).reverse().map( ( [ x, y, z ] ) => [ - x, y, z ] ) ];
		const c = [ 0, full.reduce( ( s, p ) => s + p[ 1 ], 0 ) / full.length, R[ 0 ][ 2 ] ];
		for ( let k = 0; k < full.length; k ++ ) {

			const a = full[ k ], b = full[ ( k + 1 ) % full.length ];
			tri( 'paint', c, b, a ); tri( 'paint', c, a, b ); // both sides, so the face shows whichever way it winds

		}

	}

	return { buf, belt, hw, roof, hwR, bot };

}

function geo( arr ) {

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( arr, 3 ) );
	g.computeVertexNormals();
	return g;

}

export function buildCar( id = 'rally', colorIndex = 0 ) {

	const D = DEFS[ id ] || DEFS.rally;
	const root = new THREE.Group();
	const body = new THREE.Group();
	body.position.y = GROUND;
	root.add( body );

	const flat = { flatShading: true };
	const M = {
		paint: new THREE.MeshPhysicalMaterial( { color: D.colors[ 0 ], metalness: 0.15, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.08, ...flat } ),
		accent: new THREE.MeshStandardMaterial( { color: D.accent, metalness: 0.1, roughness: 0.4, ...flat } ),
		glass: new THREE.MeshStandardMaterial( { color: 0x0d141b, metalness: 0.6, roughness: 0.08, ...flat } ),
		black: new THREE.MeshStandardMaterial( { color: 0x0c0d0f, roughness: 0.9, side: THREE.DoubleSide } ),
		trim: new THREE.MeshStandardMaterial( { color: 0x1d1f23, roughness: 0.6, ...flat } ),
		chrome: new THREE.MeshStandardMaterial( { color: 0xd6dade, metalness: 1, roughness: 0.18 } ),
		lamp: new THREE.MeshStandardMaterial( { color: 0xeef3ff, emissive: 0xcfe0ff, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.2 } ),
		tail: new THREE.MeshStandardMaterial( { color: 0x8a0d12, emissive: 0xff2020, emissiveIntensity: 0.45, roughness: 0.2 } ),
		amber: new THREE.MeshStandardMaterial( { color: 0xff9a1a, emissive: 0xff8000, emissiveIntensity: 0.3, roughness: 0.2 } ),
		rim: new THREE.MeshStandardMaterial( { color: D.rim, metalness: 0.75, roughness: 0.3, ...flat } ),
		tyre: new THREE.MeshStandardMaterial( { color: 0x151517, roughness: 0.95, ...flat } ),
	};

	const B = buildBody( D );
	for ( const k in B.buf ) {

		if ( ! B.buf[ k ].length ) continue;
		const m = new THREE.Mesh( geo( B.buf[ k ] ), M[ k ] );
		m.castShadow = k !== 'glass';
		body.add( m );

	}

	const box = ( w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0 ) => {

		const b = new THREE.Mesh( new THREE.BoxGeometry( w, h, d ), mat );
		b.position.set( x, y, z ); b.rotation.set( rx, ry, rz ); b.castShadow = true;
		body.add( b );
		return b;

	};

	const cyl = ( r, len, mat, x, y, z, seg = 12 ) => {

		const c = new THREE.Mesh( new THREE.CylinderGeometry( r, r, len, seg ).rotateX( Math.PI / 2 ), mat );
		c.position.set( x, y, z );
		body.add( c );
		return c;

	};

	const zF = D.zF, zR = D.zR, wF = B.hw( zF ), wR = B.hw( zR ), bF = B.belt( zF ), bR = B.belt( zR );

	// ---- front face: bumper, grille, lights ----
	box( wF * 2 - 0.06, 0.12, 0.05, M.trim, 0, D.sill + 0.12, zF + 0.01 ); // lower bumper / intake
	if ( D.lights.front === 'round' ) {

		box( 0.42, 0.09, 0.03, M.black, 0, bF - 0.12, zF + 0.012 ); // small grille
		for ( const s of [ - 1, 1 ] ) {

			box( 0.34, 0.12, 0.03, M.lamp, s * ( wF - 0.24 ), bF - 0.1, zF + 0.012 );
			box( 0.1, 0.07, 0.03, M.amber, s * ( wF - 0.06 ), bF - 0.12, zF - 0.02 );

		}

	} else if ( D.lights.front === 'rect' ) {

		box( wF * 2 - 0.12, 0.16, 0.03, M.black, 0, bF - 0.12, zF + 0.012 ); // full-width grille band
		for ( const s of [ - 1, 1 ] ) {

			box( 0.36, 0.14, 0.035, M.lamp, s * ( wF - 0.25 ), bF - 0.12, zF + 0.014 );
			box( 0.12, 0.14, 0.035, M.amber, s * ( wF - 0.03 ), bF - 0.12, zF + 0.01 );

		}

		box( 0.16, 0.1, 0.04, M.chrome, 0, bF - 0.12, zF + 0.02 );

	} else {

		for ( const s of [ - 1, 1 ] ) {

			box( 0.13, 0.13, 0.03, M.chrome, s * 0.09, bF - 0.13, zF + 0.012 ); // twin grille
			box( 0.11, 0.11, 0.035, M.black, s * 0.09, bF - 0.13, zF + 0.016 );
			box( 0.5, 0.14, 0.03, M.black, s * ( wF - 0.29 ), bF - 0.12, zF + 0.01 ); // lamp housing
			for ( const k of [ 0, 1 ] ) cyl( 0.055, 0.03, M.lamp, s * ( wF - 0.15 - k * 0.2 ), bF - 0.12, zF + 0.02, 14 );

		}

	}

	// ---- rear face: lights, plate ----
	for ( const s of [ - 1, 1 ] ) {

		if ( D.lights.rear === 'tall' ) box( 0.12, 0.5, 0.03, M.tail, s * ( wR - 0.08 ), bR + 0.12, zR - 0.012 );
		else box( 0.44, 0.13, 0.03, M.tail, s * ( wR - 0.24 ), bR - 0.12, zR - 0.012 );

	}

	box( 0.5, 0.11, 0.02, new THREE.MeshStandardMaterial( { color: 0xf2f2ee, roughness: 0.6 } ), 0, D.sill + 0.3, zR - 0.015 );
	box( wR * 2 - 0.04, 0.1, 0.05, M.trim, 0, D.sill + 0.1, zR - 0.01 );
	for ( const [ ex, ey ] of D.exhaust ) cyl( 0.045, 0.16, M.chrome, ex, ey, zR - 0.03, 10 );

	// ---- mirrors, door handles ----
	const zA = D.gh[ 1 ] - 0.12;
	for ( const s of [ - 1, 1 ] ) {

		box( 0.1, 0.1, 0.16, M.paint, s * ( B.hw( zA ) + 0.06 ), B.belt( zA ) + 0.09, zA );
		box( 0.03, 0.08, 0.12, M.glass, s * ( B.hw( zA ) + 0.11 ), B.belt( zA ) + 0.09, zA - 0.01 );
		box( 0.02, 0.025, 0.12, M.trim, s * ( B.hw( 0.1 ) + 0.005 ), B.belt( 0.1 ) - 0.09, 0.1 );

	}

	// ---- extras ----
	const X = new Set( D.extras );
	if ( X.has( 'scoop' ) ) {

		const g = new THREE.BufferGeometry();
		const y0 = B.belt( 1.35 ) + 0.06, y1 = B.belt( 0.95 ) + 0.065;
		const v = [ - 0.28, y0, 1.35, 0.28, y0, 1.35, 0.25, y1 + 0.08, 0.95, - 0.25, y1 + 0.08, 0.95, - 0.25, y1, 0.95, 0.25, y1, 0.95 ];
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( v, 3 ) );
		g.setIndex( [ 0, 2, 1, 0, 3, 2, 0, 4, 3, 1, 2, 5, 3, 4, 5, 3, 5, 2 ] );
		g.computeVertexNormals();
		const sc = new THREE.Mesh( g, M.paint ); sc.castShadow = true; body.add( sc );
		box( 0.44, 0.06, 0.02, M.black, 0, y1 + 0.045, 0.94 );

	}

	if ( X.has( 'wing' ) ) {

		const zw = zR + 0.22, yw = B.belt( zw ) + 0.3;
		box( 1.6, 0.03, 0.32, M.paint, 0, yw, zw, 0.08 );
		box( 1.6, 0.02, 0.1, M.black, 0, yw + 0.04, zw - 0.17, 0.5 );
		for ( const s of [ - 1, 1 ] ) { box( 0.04, 0.3, 0.12, M.black, s * 0.55, yw - 0.15, zw ); box( 0.02, 0.2, 0.4, M.paint, s * 0.8, yw + 0.02, zw ); }

	}

	if ( X.has( 'vent' ) ) box( 0.3, 0.05, 0.2, M.black, 0, B.roof( - 0.3 ) + 0.02, - 0.3 );
	if ( X.has( 'fogs' ) ) for ( const s of [ - 1, 1 ] ) cyl( 0.075, 0.04, M.lamp, s * 0.5, D.sill + 0.2, zF + 0.03, 14 );
	if ( X.has( 'flaps' ) ) for ( const [ x, z ] of [ [ 0.72, D.axle[ 0 ] - 0.48 ], [ - 0.72, D.axle[ 0 ] - 0.48 ], [ 0.72, D.axle[ 1 ] - 0.48 ], [ - 0.72, D.axle[ 1 ] - 0.48 ] ] ) box( 0.28, 0.22, 0.012, new THREE.MeshStandardMaterial( { color: 0xd01c22, roughness: 0.8 } ), x, 0.17, z );
	if ( X.has( 'splitter' ) ) box( wF * 2 + 0.06, 0.03, 0.2, M.black, 0, D.sill - 0.02, zF - 0.02 );
	if ( X.has( 'tailspoiler' ) ) box( B.hwR( D.gh[ 0 ] ) * 2 + 0.1, 0.03, 0.26, M.black, 0, B.roof( D.gh[ 0 ] ) + 0.06, D.gh[ 0 ] - 0.08, - 0.18 );
	if ( X.has( 'lip' ) ) box( 1.1, 0.03, 0.1, M.paint, 0, B.belt( zR + 0.1 ) + 0.07, zR + 0.12, - 0.25 );

	// ---- wheels ----
	const R = D.tyreR;
	const tyreGeo = new THREE.CylinderGeometry( R, R, 0.24, 16 ).rotateZ( Math.PI / 2 );
	const rimGeo = new THREE.CylinderGeometry( R - 0.09, R - 0.09, 0.02, 16 ).rotateZ( Math.PI / 2 );
	const hubGeo = new THREE.CylinderGeometry( 0.05, 0.05, 0.05, 8 ).rotateZ( Math.PI / 2 );
	const spokeGeo = new THREE.BoxGeometry( 0.025, R - 0.12, 0.05 ).translate( 0, ( R - 0.12 ) / 2 + 0.03, 0 );
	const wheels = [];
	for ( const [ x, z ] of [ [ D.track, D.axle[ 0 ] ], [ - D.track, D.axle[ 0 ] ], [ D.track, D.axle[ 1 ] ], [ - D.track, D.axle[ 1 ] ] ] ) {

		const pivot = new THREE.Group(), spin = new THREE.Group();
		pivot.position.set( x, R, z );
		const t = new THREE.Mesh( tyreGeo, M.tyre ); t.castShadow = true; spin.add( t );
		const sx = Math.sign( x );
		const dish = new THREE.Mesh( rimGeo, new THREE.MeshStandardMaterial( { color: 0x101114, roughness: 0.6 } ) ); dish.position.x = sx * 0.1; spin.add( dish );
		const lip = new THREE.Mesh( new THREE.TorusGeometry( R - 0.085, 0.014, 4, 16 ).rotateY( Math.PI / 2 ), M.rim ); lip.position.x = sx * 0.115; spin.add( lip );
		const hub = new THREE.Mesh( hubGeo, M.rim ); hub.position.x = sx * 0.115; spin.add( hub );
		for ( let k = 0; k < D.spokes; k ++ ) {

			const s = new THREE.Mesh( spokeGeo, M.rim );
			s.position.x = sx * 0.112; s.rotation.x = k / D.spokes * Math.PI * 2; spin.add( s );

		}

		const disc = new THREE.Mesh( new THREE.CylinderGeometry( R - 0.13, R - 0.13, 0.02, 12 ).rotateZ( Math.PI / 2 ), M.chrome ); disc.position.x = sx * 0.06; pivot.add( disc );
		const cal = new THREE.Mesh( new THREE.BoxGeometry( 0.05, 0.12, 0.14 ), new THREE.MeshStandardMaterial( { color: id === 'rally' ? 0xc9a13b : 0xc81e24 } ) );
		cal.position.set( sx * 0.08, 0.1, z > 0 ? - 0.08 : 0.08 ); pivot.add( cal );
		pivot.add( spin );
		body.add( pivot );
		wheels.push( { pivot, spin, baseY: R } );

	}

	// ---- exhaust flame for pops ----
	const flameMat = new THREE.MeshBasicMaterial( { color: 0xff9a2e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false } );
	const flameGeo = new THREE.ConeGeometry( 0.1, 0.6, 10, 1, true ).rotateX( - Math.PI / 2 ).translate( 0, 0, - 0.3 );
	const flame = new THREE.Mesh( flameGeo, flameMat );
	flame.position.set( D.exhaust[ 0 ][ 0 ], D.exhaust[ 0 ][ 1 ], zR - 0.1 );
	const core = new THREE.Mesh( flameGeo, new THREE.MeshBasicMaterial( { color: 0xbfd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false } ) );
	core.scale.set( 0.5, 0.5, 0.55 ); flame.add( core );
	body.add( flame );
	let flameT = 0;

	// ---- the real car model replaces the procedural body and wheels when it has loaded ----
	const model = MODELS[ id ];
	const paints = [];
	if ( model ) {

		for ( const o of body.children.slice() ) if ( o !== flame ) body.remove( o );
		const src = model.children.find( c => c.name === 'body' ).clone();
		src.traverse( o => {

			if ( ! o.isMesh ) return;
			o.castShadow = true; o.receiveShadow = true;
			o.material = o.material.clone(); // per car: the game and the showroom set different reflections
			if ( o.material.name === 'paint' ) {

				paints.push( { m: o.material, color: o.material.color.clone(), map: o.material.map } );

			}

			if ( o.material.transparent ) o.castShadow = false;

		} );
		body.add( src );
		wheels.length = 0;
		for ( let i = 0; i < 4; i ++ ) {

			const w = model.children.find( c => c.name === 'wheel_' + i ); // top level only: sub-meshes of a wheel are named wheel_1, wheel_2 too
			const pivot = new THREE.Group(), spin = new THREE.Group();
			// the hub is the centre of the wheel's bounds (the node transform also carries mesh quantization)
			const hub = new THREE.Box3().setFromObject( w ).getCenter( new THREE.Vector3() );
			pivot.position.copy( hub );
			const wm = w.clone(); wm.position.sub( hub );
			wm.traverse( o => { if ( o.isMesh ) { o.castShadow = true; o.material = o.material.clone(); } } );
			spin.add( wm ); pivot.add( spin ); body.add( pivot );
			wheels.push( { pivot, spin, baseY: hub.y } );

		}

		const box = new THREE.Box3().setFromObject( src );
		flame.position.set( D.exhaust[ 0 ][ 0 ], 0.28, box.min.z - 0.02 );

	}

	// ---- soft contact shadow ----
	const sc = document.createElement( 'canvas' );
	sc.width = sc.height = 128;
	const ctx = sc.getContext( '2d' );
	const grd = ctx.createRadialGradient( 64, 64, 8, 64, 64, 62 );
	grd.addColorStop( 0, 'rgba(0,0,0,0.55)' ); grd.addColorStop( 1, 'rgba(0,0,0,0)' );
	ctx.fillStyle = grd; ctx.fillRect( 0, 0, 128, 128 );
	const shadow = new THREE.Mesh( new THREE.PlaneGeometry( 2.4, 5.0 ), new THREE.MeshBasicMaterial( { map: new THREE.CanvasTexture( sc ), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 6, polygonOffsetUnits: - 20 } ) );
	shadow.rotation.x = - Math.PI / 2;
	shadow.renderOrder = 6;

	let ci = 0;
	const car = {
		id, root, body, wheels, shadow, colors: D.colors,
		setColor( i ) {

			ci = ( ( i % D.colors.length ) + D.colors.length ) % D.colors.length;
			M.paint.color.setHex( D.colors[ ci ] );
			// model paint: colour 0 is the car's own livery, the others repaint it
			for ( const p of paints ) {

				if ( ci === 0 ) { p.m.color.copy( p.color ); p.m.map = p.map; } else { p.m.color.setHex( D.colors[ ci ] ); p.m.map = null; }
				p.m.needsUpdate = true;

			}

			return ci;

		},
		nextColor() { return car.setColor( ci + 1 ); },
		pop( k = 1 ) { buzz( k ); flameT = 0.07 + 0.05 * k; flame.scale.set( 0.8 + Math.random() * 0.6, 0.8 + Math.random() * 0.6, 0.6 + k * ( 0.6 + Math.random() ) ); },
		animate( dt ) {

			flameT = Math.max( 0, flameT - dt );
			const o = Math.min( 1, flameT * 12 );
			flameMat.opacity = o * 0.9; core.material.opacity = o * 0.8; flame.visible = o > 0;

		},
		dispose() { root.traverse( o => { if ( o.isMesh && ! o.userData.shared ) o.geometry.dispose(); } ); },
	};
	car.setColor( colorIndex );
	return car;

}

// haptics for exhaust pops: phone vibration (Android browsers) and gamepad rumble
let buzzT = 0;
function buzz( k ) {

	const now = performance.now();
	if ( now - buzzT < 60 ) return;
	buzzT = now;
	try { if ( navigator.vibrate ) navigator.vibrate( Math.round( 18 + k * 30 ) ); } catch { /* not allowed */ }
	rumble( 0.3 + 0.5 * k, 0.6, 70 );

}

export function rumble( strong, weak, ms ) {

	try {

		const pad = navigator.getGamepads ? [ ...navigator.getGamepads() ].find( g => g && g.vibrationActuator ) : null;
		if ( pad ) pad.vibrationActuator.playEffect( 'dual-rumble', { duration: ms, strongMagnitude: Math.min( 1, strong ), weakMagnitude: Math.min( 1, weak ) } );

	} catch { /* no rumble */ }

}
