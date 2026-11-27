// 2D map from the Maa- ja Ruumiamet tile service (orthophoto + street names), drawn on a canvas.
// Used twice: the small heading-up minimap in the HUD, and the full-screen map (M) where a click teleports the car.
import { ORIGIN_E, ORIGIN_N } from './world.js';

const TMS = 'https://tiles.maaamet.ee/tm/tms/1.0.0/';
const GRID_E = 40500, GRID_N = 5993000, RES0 = 4000; // L-EST tile grid: origin and m/px at zoom 0
const MAXZ = 14;

const cache = new Map();
function tile( layer, z, x, y ) {

	const key = layer + z + '/' + x + '/' + y;
	let t = cache.get( key );
	if ( ! t ) {

		t = { img: new Image(), ok: false, used: 0 };
		t.img.crossOrigin = 'anonymous';
		t.img.onload = () => { t.ok = true; };
		t.img.src = TMS + layer + '/' + z + '/' + x + '/' + y + ( layer === 'foto' ? '.jpg' : '.png' );
		cache.set( key, t );
		if ( cache.size > 900 ) {

			// drop the least recently used quarter
			const list = [ ...cache.entries() ].sort( ( a, b ) => a[ 1 ].used - b[ 1 ].used ).slice( 0, 220 );
			for ( const [ k, v ] of list ) { v.img.src = ''; cache.delete( k ); }

		}

	}

	t.used = performance.now();
	return t;

}

export class TileMap {

	constructor( canvas, { labels = true, rotate = false } = {} ) {

		this.canvas = canvas;
		this.ctx = canvas.getContext( '2d' );
		this.labels = labels;
		this.rotate = rotate;
		this.E = ORIGIN_E; this.N = ORIGIN_N; // view centre (L-EST metres)
		this.mpp = 2; // metres per CSS pixel
		this.heading = 0; // radians, for heading-up maps
		this.car = null; // { E, N, yaw }
		this.places = [];
		this.cursor = false;

	}

	resize() {

		const r = this.canvas.getBoundingClientRect(), d = Math.min( 2, window.devicePixelRatio || 1 );
		const w = Math.max( 1, Math.round( r.width * d ) ), h = Math.max( 1, Math.round( r.height * d ) );
		if ( this.canvas.width !== w || this.canvas.height !== h ) { this.canvas.width = w; this.canvas.height = h; }
		this.dpr = d; this.w = r.width; this.h = r.height;

	}

	// CSS pixel inside the canvas -> L-EST
	toEN( px, py ) {

		let dx = ( px - this.w / 2 ) * this.mpp, dy = ( py - this.h / 2 ) * this.mpp;
		if ( this.rotate ) { const c = Math.cos( this.heading ), s = Math.sin( this.heading ); [ dx, dy ] = [ dx * c - dy * s, dx * s + dy * c ]; }
		return { E: this.E + dx, N: this.N - dy };

	}

	draw() {

		this.resize();
		const ctx = this.ctx, d = this.dpr, W = this.w, H = this.h;
		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.fillStyle = '#5d6a52';
		ctx.fillRect( 0, 0, this.canvas.width, this.canvas.height );
		// zoom level whose pixels are about the size of a screen pixel
		const z = Math.max( 5, Math.min( MAXZ, Math.ceil( Math.log2( RES0 / ( this.mpp / d ) ) - 0.25 ) ) );
		const tileM = RES0 / 2 ** z * 256;
		const k = 1 / this.mpp; // CSS px per metre
		ctx.setTransform( d, 0, 0, d, 0, 0 );
		ctx.translate( W / 2, H / 2 );
		if ( this.rotate ) ctx.rotate( - this.heading );
		const R = Math.hypot( W, H ) / 2 * this.mpp; // metres from the centre to a corner
		const tx0 = Math.floor( ( this.E - R - GRID_E ) / tileM ), tx1 = Math.floor( ( this.E + R - GRID_E ) / tileM );
		const ty0 = Math.floor( ( this.N - R - GRID_N ) / tileM ), ty1 = Math.floor( ( this.N + R - GRID_N ) / tileM );
		ctx.imageSmoothingEnabled = true;
		for ( const layer of this.labels ? [ 'foto', 'hybriid' ] : [ 'foto' ] ) {

			for ( let ty = ty0; ty <= ty1; ty ++ ) for ( let tx = tx0; tx <= tx1; tx ++ ) {

				const e0 = GRID_E + tx * tileM, n1 = GRID_N + ( ty + 1 ) * tileM;
				const x = ( e0 - this.E ) * k, y = ( this.N - n1 ) * k, s = tileM * k;
				const t = tile( layer, z, tx, ty );
				if ( t.ok ) { ctx.drawImage( t.img, x, y, s + 0.6, s + 0.6 ); continue; }
				if ( layer !== 'foto' ) continue;
				// not loaded yet: a scaled-up parent tile keeps the map from flashing
				for ( let up = 1; up <= 4 && z - up >= 5; up ++ ) {

					const pz = z - up, pM = RES0 / 2 ** pz * 256;
					const px = Math.floor( ( e0 + 1 - GRID_E ) / pM ), py = Math.floor( ( n1 - 1 - GRID_N ) / pM );
					const p = cache.get( 'foto' + pz + '/' + px + '/' + py );
					if ( ! p || ! p.ok ) { if ( up === 1 ) tile( 'foto', pz, px, py ); continue; }
					const f = 256 / 2 ** up, sx = ( e0 - ( GRID_E + px * pM ) ) / pM * 256, sy = ( ( GRID_N + ( py + 1 ) * pM ) - n1 ) / pM * 256;
					ctx.drawImage( p.img, sx, sy, f, f, x, y, s + 0.6, s + 0.6 );
					break;

				}

			}

		}

		// places
		ctx.font = '400 17px "VT323", monospace';
		ctx.textAlign = 'center';
		for ( const p of this.places ) {

			const x = ( p.E - this.E ) * k, y = ( this.N - p.N ) * k;
			ctx.save(); ctx.translate( x, y ); if ( this.rotate ) ctx.rotate( this.heading );
			ctx.fillStyle = '#e63b2e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc( 0, 0, 5, 0, 7 ); ctx.fill(); ctx.stroke();
			ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText( p.name.toUpperCase(), 0, - 10 );
			ctx.fillStyle = '#fff'; ctx.fillText( p.name.toUpperCase(), 0, - 10 );
			ctx.restore();

		}

		// the car: an arrow along its heading
		if ( this.car ) {

			const x = ( this.car.E - this.E ) * k, y = ( this.N - this.car.N ) * k;
			ctx.save(); ctx.translate( x, y ); ctx.rotate( Math.PI - this.car.yaw );
			const sc = this.rotate ? 1 : 1.25;
			ctx.scale( sc, sc );
			ctx.beginPath(); ctx.moveTo( 0, - 11 ); ctx.lineTo( 8, 8 ); ctx.lineTo( 0, 3 ); ctx.lineTo( - 8, 8 ); ctx.closePath();
			ctx.fillStyle = '#ffb400'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
			ctx.restore();

		}

		ctx.setTransform( d, 0, 0, d, 0, 0 );
		if ( this.cursor ) {

			ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
			ctx.beginPath(); ctx.moveTo( W / 2 - 14, H / 2 ); ctx.lineTo( W / 2 - 4, H / 2 ); ctx.moveTo( W / 2 + 4, H / 2 ); ctx.lineTo( W / 2 + 14, H / 2 );
			ctx.moveTo( W / 2, H / 2 - 14 ); ctx.lineTo( W / 2, H / 2 - 4 ); ctx.moveTo( W / 2, H / 2 + 4 ); ctx.lineTo( W / 2, H / 2 + 14 ); ctx.stroke();
			ctx.shadowBlur = 0;

		}

	}

	zoomAt( f, px = this.w / 2, py = this.h / 2 ) {

		const a = this.toEN( px, py );
		this.mpp = Math.max( 0.18, Math.min( 40, this.mpp * f ) );
		const b = this.toEN( px, py );
		this.E += a.E - b.E; this.N += a.N - b.N;

	}

	pan( dx, dy ) {

		const p = this.toEN( this.w / 2 - dx, this.h / 2 - dy );
		this.E = p.E; this.N = p.N;

	}

}

export const worldToEN = ( x, z ) => ( { E: x + ORIGIN_E, N: - z + ORIGIN_N } );
export const enToWorld = ( E, N ) => ( { x: E - ORIGIN_E, z: - ( N - ORIGIN_N ) } );
