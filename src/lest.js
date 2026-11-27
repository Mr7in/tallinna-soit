// L-EST97 (EPSG:3301) <-> WGS84 lat/lon. Lambert conformal conic, 2 standard parallels, GRS80.
const a = 6378137, f = 1 / 298.257222101;
const e = Math.sqrt( 2 * f - f * f );
const D = Math.PI / 180;
const phi1 = 58 * D, phi2 = ( 59 + 1 / 3 ) * D, phi0 = 57.51755393055556 * D, lam0 = 24 * D;
const FE = 500000, FN = 6375000;

const m = p => Math.cos( p ) / Math.sqrt( 1 - e * e * Math.sin( p ) ** 2 );
const t = p => Math.tan( Math.PI / 4 - p / 2 ) / Math.pow( ( 1 - e * Math.sin( p ) ) / ( 1 + e * Math.sin( p ) ), e / 2 );
const n = ( Math.log( m( phi1 ) ) - Math.log( m( phi2 ) ) ) / ( Math.log( t( phi1 ) ) - Math.log( t( phi2 ) ) );
const F = m( phi1 ) / ( n * Math.pow( t( phi1 ), n ) );
const rho = p => a * F * Math.pow( t( p ), n );
const rho0 = rho( phi0 );

// returns { E, N } in metres
export function toLest( lat, lon ) {

	const r = rho( lat * D ), th = n * ( lon * D - lam0 );
	return { E: FE + r * Math.sin( th ), N: FN + rho0 - r * Math.cos( th ) };

}

export function fromLest( E, N ) {

	const dx = E - FE, dy = rho0 - ( N - FN );
	const r = Math.sign( n ) * Math.hypot( dx, dy );
	const tt = Math.pow( r / ( a * F ), 1 / n );
	const th = Math.atan2( dx, dy );
	let p = Math.PI / 2 - 2 * Math.atan( tt );
	for ( let i = 0; i < 8; i ++ ) {

		const es = e * Math.sin( p );
		p = Math.PI / 2 - 2 * Math.atan( tt * Math.pow( ( 1 - es ) / ( 1 + es ), e / 2 ) );

	}

	return { lat: p / D, lon: ( th / n + lam0 ) / D };

}
