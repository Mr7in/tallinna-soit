import * as THREE from 'three';

// Street name plates on corner buildings, after Tallinn's standard: the street name and the house number on
// separate plates, colour by district (public/city/n_X_Y.json, scripts/prepare-names.mjs).
// Names and numbers are drawn once into a shared atlas and reused; one mesh (one draw call) per chunk.

const STYLE = [
	// [plate background, border and text, number background, number border and text]
	[ '#1c3a8c', '#ffffff', '#ffffff', '#1c3a8c' ], // blue: Kesklinn, Põhja-Tallinn, Kristiine, Lasnamäe, Mustamäe, Haabersti
	[ '#0f6e3a', '#ffffff', '#ffffff', '#0f6e3a' ], // green: Nõmme
	[ '#ffffff', '#6a3a1e', '#6a3a1e', '#ffffff' ], // white with brown: Pirita
	[ '#6a3a1e', '#ffffff', '#6a3a1e', '#ffffff' ], // brown: Vanalinn, Kadriorg
];
const SIZE = 2048, ROW = 40, NAME_W = 512, NUM_W = 96, NAME_ROWS = 38; // names above, numbers below
const H = 0.2, LIFT = 2.7; // plate height and centre height on the wall (m)

class Atlas {

	constructor() {

		this.canvas = document.createElement( 'canvas' );
		this.canvas.width = this.canvas.height = SIZE;
		this.ctx = this.canvas.getContext( '2d' );
		this.tex = new THREE.CanvasTexture( this.canvas );
		this.tex.colorSpace = THREE.SRGBColorSpace;
		this.tex.anisotropy = 4;
		this.slots = new Map(); // key -> { u0, v0, u1, v1, w (px), refs }
		this.freeNames = Array.from( { length: ( SIZE / NAME_W ) * NAME_ROWS }, ( _, i ) => i ).reverse();
		const numRows = Math.floor( ( SIZE - NAME_ROWS * ROW ) / ROW );
		this.freeNums = Array.from( { length: Math.floor( SIZE / NUM_W ) * numRows }, ( _, i ) => i ).reverse();
		this.dirty = false;

	}

	// a drawn plate for this text and style, or null when the atlas is full
	get( text, style, number ) {

		const key = ( number ? '#' : '' ) + style + '|' + text;
		let s = this.slots.get( key );
		if ( s ) { s.refs ++; return s; }
		const free = number ? this.freeNums : this.freeNames;
		if ( ! free.length ) {

			// reuse a slot nobody shows any more
			for ( const [ k, o ] of this.slots ) if ( o.refs === 0 && o.number === number ) { this.slots.delete( k ); free.push( o.idx ); break; }
			if ( ! free.length ) return null;

		}

		const idx = free.pop(), cw = number ? NUM_W : NAME_W, cols = SIZE / cw;
		const x0 = ( idx % cols ) * cw, y0 = ( number ? NAME_ROWS * ROW : 0 ) + Math.floor( idx / cols ) * ROW;
		const [ bg, fg, nbg, nfg ] = STYLE[ style ];
		const back = number ? nbg : bg, ink = number ? nfg : fg;
		const c = this.ctx;
		c.font = 'bold 27px Arial, Helvetica, sans-serif';
		const tw = c.measureText( text ).width, pad = number ? 10 : 14;
		const w = Math.min( cw, Math.max( number ? 44 : 60, Math.ceil( tw + pad * 2 ) ) );
		c.clearRect( x0, y0, cw, ROW );
		c.fillStyle = back; c.fillRect( x0, y0, w, ROW );
		c.strokeStyle = ink; c.lineWidth = 2; c.strokeRect( x0 + 3, y0 + 3, w - 6, ROW - 6 );
		c.fillStyle = ink; c.textBaseline = 'middle'; c.textAlign = 'center';
		const sx = Math.min( 1, ( w - pad * 2 ) / tw );
		c.save(); c.translate( x0 + w / 2, y0 + ROW / 2 + 1 ); c.scale( sx, 1 ); c.fillText( text, 0, 0 ); c.restore();
		s = { idx, number, w, refs: 1, u0: x0 / SIZE, u1: ( x0 + w ) / SIZE, v0: 1 - ( y0 + ROW ) / SIZE, v1: 1 - y0 / SIZE };
		this.slots.set( key, s );
		this.dirty = true;
		return s;

	}

	release( s ) { s.refs = Math.max( 0, s.refs - 1 ); }

	flush() { if ( this.dirty ) { this.tex.needsUpdate = true; this.dirty = false; } }

}

export class StreetNames {

	constructor( roads ) {

		this.roads = roads;
		this.world = roads.world;
		this.index = null;
		this.atlas = null;
		this.mat = null;
		this.facades = null; // set by main: the photo facade layer
		fetch( './city/names.json' ).then( r => r.json() ).then( k => { this.index = new Set( k ); } ).catch( () => { this.index = new Set(); } );

	}

	// fetch the chunk's plates; they are built once the chunk's streets are in
	load( c ) {

		const go = () => {

			if ( ! c.alive || ! this.index.has( c.key ) ) return;
			fetch( `./city/n_${c.key}.json` ).then( r => r.json() ).then( list => { c.plates = list; if ( c.group ) this.build( c ); } ).catch( () => {} );

		};
		if ( this.index ) go(); else setTimeout( () => this.index && go(), 1500 );

	}

	build( c ) {

		if ( ! c.alive || ! c.plates || c.plateMesh || ! c.group ) return;
		if ( ! this.atlas ) {

			this.atlas = new Atlas();
			this.mat = new THREE.MeshLambertMaterial( { map: this.atlas.tex, emissiveMap: this.atlas.tex, emissive: 0x555555, polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 2 } );

		}

		const W = this.world, P = [], N = [], UV = [], used = [], refs = [];
		const probe = new THREE.Vector3(), cp = new THREE.Vector3();
		const quad = ( cx, cy, cz, rx, rz, nx, nz, x0, x1, s ) => {

			const a = [ cx + rx * x0, cy - H / 2, cz + rz * x0 ], b = [ cx + rx * x1, cy - H / 2, cz + rz * x1 ];
			const d = [ cx + rx * x0, cy + H / 2, cz + rz * x0 ], e = [ cx + rx * x1, cy + H / 2, cz + rz * x1 ];
			P.push( ...a, ...b, ...e, ...a, ...e, ...d );
			for ( let k = 0; k < 6; k ++ ) N.push( nx, 0, nz );
			UV.push( s.u0, s.v0, s.u1, s.v0, s.u1, s.v1, s.u0, s.v0, s.u1, s.v1, s.u0, s.v1 );

		};
		for ( const [ x, z, yaw, style, name, num ] of c.plates ) {

			let px = x, pz = z;
			const nx = Math.sin( yaw ), nz = Math.cos( yaw );
			const y = W.height( x, z ) + LIFT;
			// snap onto the 3D building's wall when it is close (OSM outlines and the 3D buildings differ a little)
			// (probe from the street side, so a facade standing proud of the OSM outline is found too)
			const hit = W.closest( probe.set( x + nx * 3, y, z + nz * 3 ), 4.5, cp );
			if ( hit && ( probe.x - cp.x ) * nx + ( probe.z - cp.z ) * nz > 0.5 ) { px = cp.x + nx * 0.15; pz = cp.z + nz * 0.15; } // clear of the photo facade layer
			const sn = this.atlas.get( name, style, false );
			if ( ! sn ) continue;
			const first = P.length / 3;
			const sm = num ? this.atlas.get( String( num ), style, true ) : null;
			used.push( sn ); if ( sm ) used.push( sm );
			// facing the plate (looking along -normal), its right is (nz, -nx)
			const rx = nz, rz = - nx;
			const wn = H * sn.w / ROW, wm = sm ? H * sm.w / ROW : 0, gap = sm ? 0.03 : 0, tot = wn + gap + wm;
			quad( px, y, pz, rx, rz, nx, nz, - tot / 2, - tot / 2 + wn, sn );
			if ( sm ) quad( px, y, pz, rx, rz, nx, nz, tot / 2 - wm, tot / 2, sm );
			refs.push( { first, count: P.length / 3 - first, x: px, y, z: pz, nx, nz, tries: 0 } );

		}

		this.atlas.flush();
		c.plateSlots = used;
		if ( ! P.length ) return;
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( UV, 2 ) );
		g.computeBoundingSphere();
		c.plateMesh = new THREE.Mesh( g, this.mat );
		c.plateMesh.userData.sh = 1;
		c.plateRefs = refs;
		c.group.add( c.plateMesh );

	}

	// The photo facades load later and may stand a little proud of the 3D building: once they are in, move each
	// nearby plate onto the facade surface so it never ends up behind it.
	update( dt, x, z ) {

		const F = this.facades;
		if ( ! F || ( this.t = ( this.t || 0 ) - dt ) > 0 ) return;
		this.t = 1.5;
		const ray = this.ray || ( this.ray = new THREE.Raycaster() ), o = new THREE.Vector3(), d = new THREE.Vector3(), sph = new THREE.Sphere();
		for ( const c of this.roads.chunks.values() ) {

			const R = c.plateRefs;
			if ( ! R ) continue;
			let moved = false;
			for ( const p of R ) {

				if ( p.done || p.tries > 20 || ( p.x - x ) ** 2 + ( p.z - z ) ** 2 > 140 * 140 ) continue;
				p.tries ++;
				const near = [];
				for ( const m of F.group.children ) {

					if ( ! m.geometry || ! m.geometry.boundingSphere ) continue;
					sph.copy( m.geometry.boundingSphere ).applyMatrix4( m.matrixWorld );
					if ( sph.distanceToPoint( o.set( p.x, p.y, p.z ) ) < 4 ) near.push( m );

				}

				if ( ! near.length ) continue;
				ray.set( o.set( p.x + p.nx * 1.5, p.y, p.z + p.nz * 1.5 ), d.set( - p.nx, 0, - p.nz ) );
				ray.far = 3;
				const h = ray.intersectObjects( near, false )[ 0 ];
				p.done = true;
				if ( ! h ) continue;
				const out = 1.5 - h.distance; // facade surface relative to the plate, along the normal
				if ( out < - 0.08 ) continue; // plate already in front
				const k = out + 0.06, pos = c.plateMesh.geometry.attributes.position;
				for ( let i = p.first; i < p.first + p.count; i ++ ) pos.setXYZ( i, pos.getX( i ) + p.nx * k, pos.getY( i ), pos.getZ( i ) + p.nz * k );
				p.x += p.nx * k; p.z += p.nz * k;
				moved = true;

			}

			if ( moved ) c.plateMesh.geometry.attributes.position.needsUpdate = true;

		}

	}

	drop( c ) {

		for ( const s of c.plateSlots || [] ) this.atlas.release( s );
		c.plateSlots = null;
		if ( c.plateMesh ) { c.plateMesh.geometry.dispose(); c.plateMesh = null; }

	}

}
