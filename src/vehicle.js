import * as THREE from 'three';

// Rigid-body car with raycast suspension, slip-based tyres, engine, gearbox and AWD.
// Local frame: +Z forward, +Y up, +X left. Origin = centre of mass.
const V3 = THREE.Vector3;
const G = 9.81;

function engineTorque( TORQUE, rpm ) {

	if ( rpm <= TORQUE[ 0 ][ 0 ] ) return TORQUE[ 0 ][ 1 ];
	for ( let i = 1; i < TORQUE.length; i ++ ) {

		if ( rpm <= TORQUE[ i ][ 0 ] ) {

			const [ r0, t0 ] = TORQUE[ i - 1 ], [ r1, t1 ] = TORQUE[ i ];
			return t0 + ( t1 - t0 ) * ( rpm - r0 ) / ( r1 - r0 );

		}

	}

	return TORQUE[ TORQUE.length - 1 ][ 1 ];

}

export const GEARS = { '-1': - 3.3, 0: 0, 1: 3.45, 2: 2.06, 3: 1.45, 4: 1.09, 5: 0.85, 6: 0.7 };
const FINAL = 4.11;
const KP = 0.1, AP = 0.14, TC = 1.4, TB = 2.07; // tyre: peak slip ratio, peak slip angle, shape
export const IDLE = 850, REDLINE = 7200, LIMIT = 7500;

// three real cars (factory data; curve = full-load torque in Nm against rpm, turbo curves at full boost):
//   rally   - Subaru Impreza 22B STi (1998): EJ22G 2.2 flat-4 turbo, 280 PS @ 6000, 363 Nm @ 3200, 1270 kg, AWD (DCCD centre diff, ~36:64 front:rear),
//             5MT, wheelbase 2520 mm, track 1480/1500 mm, 0-100 km/h ~4.7 s
//   touring - Volvo 850 T-5R estate (1995): B5234T5 2.3 five-cylinder turbo, 240 PS @ 5600, 330 Nm @ 2100 (overboost),
//             1451 kg, FWD, 5MT, wheelbase 2664 mm, track 1470/1460 mm, 0-100 km/h 6.9 s
//   coupe   - BMW M3 E30 (1986): S14 2.3 four, 195 PS @ 6750, 230 Nm @ 4750, 1200 kg, RWD with limited-slip, Getrag 265
//             dog-leg 5MT, wheelbase 2565 mm, track 1412/1424 mm, 0-100 km/h 6.7 s, 7250 rpm redline
// axle = distance of the front / rear axle from the centre of mass (front-heavy cars sit closer to the front axle)
export const CAR_SPECS = [
	{ id: 'rally', name: 'Subaru Impreza 22B', drive: 'awd', split: 0.36, mass: 1270, axle: [ 1.06, - 1.46 ], track: 0.753, r: 0.3, turbo: true, redline: 7900, limit: 8100, final: 4.444, gears: [ 3.083, 2.062, 1.545, 1.151, 0.825 ],
		curve: [ [ 800, 140 ], [ 2000, 230 ], [ 2800, 330 ], [ 3200, 363 ], [ 4500, 360 ], [ 6000, 328 ], [ 7000, 285 ], [ 8100, 215 ] ], hp: 280, grip: 1.04, lsd: 0.5, cda: 0.4 },
	{ id: 'touring', name: 'Volvo 850 T-5R', drive: 'fwd', split: 1, mass: 1451, axle: [ 1.02, - 1.64 ], track: 0.735, r: 0.299, turbo: true, redline: 6500, limit: 6700, final: 4.0, gears: [ 3.07, 1.77, 1.19, 0.87, 0.7 ],
		curve: [ [ 800, 160 ], [ 1500, 250 ], [ 2100, 330 ], [ 4000, 330 ], [ 5000, 320 ], [ 5600, 307 ], [ 6200, 275 ], [ 6700, 235 ] ], hp: 240, grip: 0.98, lsd: 0, cda: 0.43 },
	{ id: 'coupe', name: 'BMW M3 E30', drive: 'rwd', split: 0, mass: 1200, axle: [ 1.26, - 1.31 ], track: 0.718, r: 0.303, turbo: false, redline: 7250, limit: 7400, final: 3.25, gears: [ 3.72, 2.4, 1.77, 1.26, 1.0 ],
		curve: [ [ 800, 130 ], [ 2500, 185 ], [ 3500, 205 ], [ 4750, 230 ], [ 6000, 218 ], [ 6750, 202 ], [ 7400, 175 ] ], hp: 195, grip: 1.0, lsd: 0.25, cda: 0.38 },
];
const GRIP = [ 0.58, 1.0, 0.92, 0.64, 0.85 ]; // off-road, asphalt, paving, gravel, cobbles

export class Vehicle {

	constructor( world ) {

		this.world = world;
		this.mass = 1380;
		const w = 1.74, h = 1.25, l = 4.4, k = 1.1;
		this.inertia = new V3();
		this.pos = new V3();
		this.quat = new THREE.Quaternion();
		this.vel = new V3();
		this.angVel = new V3();
		this.radius = 0.32;
		this.rest = 0.3;
		this.spring = 33000;
		this.wheels = [ [ 0.76, 1.28 ], [ - 0.76, 1.28 ], [ 0.77, - 1.27 ], [ - 0.77, - 1.27 ] ].map( ( [ x, z ], i ) => ( {
			local: new V3( x, - 0.05, z ), front: i < 2, left: x > 0,
			comp: 0, omega: 0, kappa: 0, steer: 0, contact: false, Fz: 0, slide: 0, spin: 0, len: this.rest,
		} ) );
		this.steer = 0;
		this.rpm = IDLE;
		this.gear = 1;
		this.auto = true;
		this.shiftT = 0;
		this.throttle = 0;
		this.spheres = [ [ 0.6, 0, 1.6 ], [ - 0.6, 0, 1.6 ], [ 0.6, 0, - 1.65 ], [ - 0.6, 0, - 1.65 ], [ 0.62, 0.05, 0 ], [ - 0.62, 0.05, 0 ], [ 0, 0.55, - 0.25 ] ].map( a => new V3( ...a ) );
		this.impact = 0;
		this.mode = 'sim';
		this.setSpec( CAR_SPECS[ 0 ] );
		this.boost = 0;
		this.events = [];
		this.popT = 0;
		this._t = { up: new V3(), fwd: new V3(), left: new V3(), F: new V3(), T: new V3(), a: new V3(), b: new V3(), c: new V3(), q: new THREE.Quaternion() };

	}

	setSpec( spec ) {

		this.spec = spec;
		this.mass = spec.mass;
		this.radius = spec.r || 0.32;
		this.redline = spec.redline;
		this.limit = spec.limit;
		const w = 1.78, h = 1.25, l = spec.axle[ 0 ] - spec.axle[ 1 ] + 1.8, k = 1.1;
		this.inertia.set( this.mass / 12 * ( h * h + l * l ) * k, this.mass / 12 * ( w * w + l * l ) * k, this.mass / 12 * ( w * w + h * h ) * k );
		this.wheels.forEach( ( wh, i ) => wh.local.set( ( i % 2 ? - 1 : 1 ) * spec.track, - 0.05, spec.axle[ i < 2 ? 0 : 1 ] ) );
		this.gearSet = { '-1': - 3.3, 0: 0 };
		spec.gears.forEach( ( g, i ) => { this.gearSet[ i + 1 ] = g; } );
		this.boost = 0;

	}

	place( x, z, yaw ) {

		const y = this.world.ground( x, z, this.world.height( x, z ) + 3 );
		this.pos.set( x, y + 0.62, z );
		this.quat.setFromAxisAngle( new V3( 0, 1, 0 ), yaw );
		this.vel.set( 0, 0, 0 );
		this.angVel.set( 0, 0, 0 );
		for ( const w of this.wheels ) { w.omega = 0; w.comp = 0; w.kappa = 0; }
		this.gear = this.auto ? 1 : this.gear;

	}

	get yaw() {

		const f = new V3( 0, 0, 1 ).applyQuaternion( this.quat );
		return Math.atan2( f.x, f.z );

	}

	get speed() { return this.vel.dot( new V3( 0, 0, 1 ).applyQuaternion( this.quat ) ); }

	shift( d ) {

		if ( this.auto ) return;
		const g = Math.max( - 1, Math.min( this.spec.gears.length, this.gear + d ) );
		if ( g !== this.gear ) { this.gear = g; this.shiftT = 0.12; }

	}

	setAuto( on ) {

		this.auto = on;
		if ( on && this.gear === 0 ) this.gear = 1;

	}

	update( dt, input ) {

		this.trees = this.world.treesNear( this.pos.x, this.pos.z, 7, this.trees || [] );
		if ( this.world.inBush( this.pos.x, this.pos.z ) ) this.vel.multiplyScalar( 1 - Math.min( 0.5, 1.2 * dt ) );

		const n = Math.min( 24, Math.max( 1, Math.ceil( dt / ( 1 / 240 ) ) ) );
		for ( let i = 0; i < n; i ++ ) this.step( dt / n, input );

	}

	step( dt, inp ) {

		const t = this._t;
		const up = t.up.set( 0, 1, 0 ).applyQuaternion( this.quat );
		const fwd = t.fwd.set( 0, 0, 1 ).applyQuaternion( this.quat );
		const left = t.left.set( 1, 0, 0 ).applyQuaternion( this.quat );
		const vF = this.vel.dot( fwd );

		// ---------- controls ----------
		let throttle = inp.throttle, brake = inp.brake;
		if ( this.auto ) {

			if ( this.gear === - 1 ) { throttle = inp.brake; brake = inp.throttle; }
			if ( this.gear >= 1 && inp.brake > 0.1 && inp.throttle < 0.1 && vF < 0.6 ) this.gear = - 1;
			else if ( this.gear === - 1 && inp.throttle > 0.1 && vF > - 0.6 ) this.gear = 1;

		}

		// blow-off valve and exhaust pops when lifting off the throttle
		if ( this.throttle > 0.5 && throttle < 0.15 ) {

			if ( this.boost > 0.45 ) this.events.push( [ 'bov', this.boost ] );
			if ( this.rpm > 3600 ) this.popT = 0.5 + Math.random() * 0.8;

		}

		if ( this.popT > 0 ) {

			this.popT -= dt;
			if ( throttle > 0.3 ) this.popT = 0;
			else if ( Math.random() < dt * 14 ) this.events.push( [ 'pop', Math.min( 1, this.rpm / 6500 ) ] );

		}

		this.throttle = throttle;
		let steerTarget;
		if ( this.mode === 'arcade' ) {

			// arcade: the front wheels show the stick, plus the counter-steer a driver would hold in a slide
			const sl = this.slip || 0;
			steerTarget = Math.max( - 0.75, Math.min( 0.75, inp.steer * 0.6 / ( 1 + Math.abs( vF ) / 30 ) - ( this.drifting ? sl * 0.55 : 0 ) ) );

		} else steerTarget = inp.steer * 0.6 / ( 1 + Math.abs( vF ) / 32 );

		this.steer += ( steerTarget - this.steer ) * Math.min( 1, dt * 12 );
		const hand = inp.handbrake;

		// ---------- engine + gearbox ----------
		this.shiftT = Math.max( 0, this.shiftT - dt );
		const S0 = this.spec, driven = S0.drive === 'fwd' ? [ 0, 1 ] : S0.drive === 'rwd' ? [ 2, 3 ] : hand ? [ 0, 1 ] : [ 0, 1, 2, 3 ];
		let wAvg = 0;
		for ( const i of driven ) wAvg += this.wheels[ i ].omega;
		wAvg /= driven.length;
		const GS = this.gearSet, S = this.spec, FIN = S.final, arcade = this.mode === 'arcade';
		const ratio = GS[ this.gear ] * FIN;
		let Te = 0;
		if ( this.gear === 0 ) {

			this.rpm += ( IDLE + throttle * 6400 - this.rpm ) * Math.min( 1, dt * 5 );

		} else {

			const wheelRpm = wAvg * ratio * 60 / ( 2 * Math.PI );
			const slipping = wheelRpm < 1300;
			const target = slipping ? Math.max( wheelRpm, IDLE + throttle * 2600 ) : wheelRpm;
			this.rpm += ( target - this.rpm ) * Math.min( 1, dt * ( slipping ? 8 : 40 ) );
			// turbo: boost builds with revs and throttle, with a bit of lag
			const want = S.turbo && throttle > 0.25 && this.rpm > 2200 ? Math.min( 1, ( this.rpm - 2200 ) / 2300 ) * throttle : 0;
			this.boost += ( want - this.boost ) * Math.min( 1, dt * ( want > this.boost ? 1.4 * this.rpm / 4000 : 5 ) );
			Te = engineTorque( S.curve, this.rpm ) * throttle * ( S.turbo ? 0.62 + 0.38 * this.boost : 1 );
			if ( ! slipping && throttle < 0.05 ) Te -= 35 + this.rpm * 0.008; // engine braking
			if ( this.rpm > this.limit ) Te = Math.min( Te, 0 );
			if ( this.shiftT > 0 ) Te = 0;

		}

		this.rpm = Math.max( IDLE * 0.9, Math.min( this.limit + 150, this.rpm ) );
		const wheelT = Te * ratio * 0.85; // split per axle below (AWD 40/60, front only with handbrake)

		if ( this.auto && this.shiftT <= 0 && this.gear >= 1 ) {

			this.sinceShift = ( this.sinceShift || 0 ) + dt;
			// use road speed (not spinning wheels) to pick gears, with hysteresis
			const roadRpm = Math.abs( vF ) / this.radius * GS[ this.gear ] * FIN * 60 / ( 2 * Math.PI );
			const lowerRpm = this.gear > 1 ? roadRpm * GS[ this.gear - 1 ] / GS[ this.gear ] : Infinity;
			if ( this.rpm > this.redline - 400 && roadRpm > this.redline - 1200 && this.gear < S.gears.length ) { this.gear ++; this.shiftT = 0.22; this.sinceShift = 0; if ( this.boost > 0.5 ) this.events.push( [ 'bov', this.boost * 0.7 ], [ 'pop', 0.9 ] ); }
			else if ( this.gear > 1 && this.sinceShift > 0.8 && roadRpm < ( throttle > 0.8 ? this.redline * 0.47 : 2100 ) && lowerRpm < this.redline - 1000 ) { this.gear --; this.shiftT = 0.15; this.sinceShift = 0; }

		}

		// ---------- forces ----------
		const F = t.F.set( 0, - G * this.mass, 0 );
		const T = t.T.set( 0, 0, 0 );
		const world = this.world;
		const dir = t.a.copy( up ).negate();
		const contacts = [];

		for ( const w of this.wheels ) {

			const mount = w.local.clone().applyQuaternion( this.quat ).add( this.pos );
			w.contact = false;
			// ray (mount -> down along body) against the terrain plane, refined once
			let gy = world.ground( mount.x, mount.z, mount.y );
			let nrm = world.groundNormal( mount.x, mount.z, mount.y, new V3() );
			let denom = nrm.dot( dir );
			let len = Infinity;
			if ( denom < - 0.3 ) {

				let tt = ( nrm.x * ( mount.x - mount.x ) + nrm.y * ( gy - mount.y ) + nrm.z * 0 ) / denom;
				const px = mount.x + dir.x * tt, pz = mount.z + dir.z * tt;
				gy = world.ground( px, pz, mount.y );
				nrm = world.groundNormal( px, pz, mount.y, new V3() );
				denom = nrm.dot( dir );
				tt = ( nrm.x * ( px - mount.x ) + nrm.y * ( gy - mount.y ) + nrm.z * ( pz - mount.z ) ) / denom;
				len = tt - this.radius;

			}

			if ( len < this.rest ) {

				const comp = Math.min( this.rest + 0.05, this.rest - len );
				const cv = ( comp - w.comp ) / dt;
				let Fs = this.spring * comp + ( cv > 0 ? 3200 : 4300 ) * cv;
				if ( comp > 0.25 ) Fs += 150000 * ( comp - 0.25 );
				w.comp = comp;
				w.Fs = Math.max( 0, Fs );
				w.contact = true;
				w.nrm = nrm;
				w.cp = mount.clone().addScaledVector( dir, len + this.radius );
				w.len = len;
				contacts.push( w );

			} else {

				w.comp = 0;
				w.Fs = 0;
				w.len = this.rest;

			}

		}

		// anti-roll bars
		for ( const [ a, b, k ] of [ [ 0, 1, 13000 ], [ 2, 3, 21000 ] ] ) {

			const A = this.wheels[ a ], B = this.wheels[ b ];
			const d = ( A.comp - B.comp ) * k;
			if ( A.contact ) A.Fs = Math.max( 0, A.Fs + d );
			if ( B.contact ) B.Fs = Math.max( 0, B.Fs - d );

		}

		if ( arcade ) this.arcadeForces( dt, inp, F, T, contacts, up, fwd, throttle, brake, hand, wheelT );
		else {

			const I = 1.3, R = this.radius;
			// drivetrain: centre diff 41/59 with a limited-slip coupling, limited-slip front and rear diffs.
			// The handbrake opens the centre coupling, so the front axle takes all the drive.
			const W = this.wheels, Td = this._td || ( this._td = [ 0, 0, 0, 0 ] );
			const clampT = ( v, m ) => Math.max( - m, Math.min( m, v ) );
			const drive = this.spec.drive, fs = arcade && drive === 'awd' ? 0.3 : this.spec.split;
			let Tf = drive === 'rwd' ? 0 : drive === 'fwd' || hand ? wheelT : wheelT * fs;
			let Tr = drive === 'fwd' || hand ? 0 : drive === 'rwd' ? wheelT : wheelT * ( 1 - fs );
			if ( drive === 'awd' && ! hand ) {

				const dW = ( W[ 0 ].omega + W[ 1 ].omega - W[ 2 ].omega - W[ 3 ].omega ) / 2;
				const Tc = clampT( 70 * dW, Math.abs( wheelT ) * 0.45 + 250 );
				Tf -= Tc; Tr += Tc;

			}

			// axle differentials: lsd 0 = open (the Volvo spins its inside front wheel), 1 = nearly locked
			const lsd = this.spec.lsd ?? 0.5;
			for ( const [ a, b, Ta ] of [ [ 0, 1, Tf ], [ 2, 3, Tr ] ] ) {

				const Tl = clampT( ( 8 + 75 * lsd ) * ( W[ a ].omega - W[ b ].omega ), Math.abs( Ta ) * ( 0.08 + 0.6 * lsd ) + 15 + 90 * lsd );
				Td[ a ] = Ta / 2 - Tl / 2;
				Td[ b ] = Ta / 2 + Tl / 2;

			}

			for ( let i = 0; i < 4; i ++ ) {

				const w = this.wheels[ i ];
				const Tdrive = Td[ i ];
				let Tb = brake * ( w.front ? 1900 : 1100 );
				if ( hand && ! w.front ) Tb += 4000;
				if ( this.auto && throttle < 0.05 && Math.abs( vF ) < 0.4 && this.gear !== 0 ) Tb += 400; // hold

				if ( ! w.contact ) {

					w.omega += Tdrive / I * dt;
					const d = Tb * dt / I;
					w.omega = Math.abs( w.omega ) <= d ? 0 : w.omega - Math.sign( w.omega ) * d;
					w.omega *= 0.999;
					w.slide = 0;
					continue;

				}

				const nrm = w.nrm;
				w.surf = world.surface( w.cp.x, w.cp.z );
				const mu = ( w.front ? 1.12 : 1.02 ) * ( this.spec.grip || 1 ) * GRIP[ w.surf ] * ( arcade ? ( w.front ? 1.08 : 0.9 * ( 1 - 0.22 * throttle * Math.abs( inp.steer ) * Math.min( 1, Math.max( 0, ( Math.abs( vF ) - 8 ) / 10 ) ) ) ) : 1 );
				const s = w.front ? this.steer : 0;
				const wf = t.b.copy( fwd ).multiplyScalar( Math.cos( s ) ).addScaledVector( left, Math.sin( s ) );
				const f = wf.addScaledVector( nrm, - nrm.dot( wf ) ).normalize();
				const side = t.c.crossVectors( nrm, f );
				const r = w.cp.clone().sub( this.pos );
				const vc = new V3().crossVectors( this.angVel, r ).add( this.vel );
				const vx = vc.dot( f ), vy = vc.dot( side );
				const Fz = Math.min( w.Fs, 12000 );
				const Vn = Math.max( Math.abs( vx ), 3 );

				// wheel spin: semi-implicit with secant tyre stiffness (lets wheels spin when saturated)
				const slope = Fz * mu * TC * TB / KP;
				const kp = w.kappa;
				const Ceff = Math.abs( kp ) > 0.02 ? Math.min( slope, Math.abs( Fz * mu * Math.sin( TC * Math.atan( TB * kp / KP ) ) / kp ) ) : slope;
				let om = ( w.omega + dt / I * ( Tdrive + R * Ceff * vx / Vn ) ) / ( 1 + dt * R * R * Ceff / ( I * Vn ) );
				const d = Tb * dt / I;
				om = Math.abs( om ) <= d ? 0 : om - Math.sign( om ) * d;
				w.omega = om;

				const kappa = Math.max( - 1.5, Math.min( 1.5, ( om * R - vx ) / Vn ) );
				w.kappa = kappa;
				// combined slip: a locked or spinning tyre loses its side grip (handbrake turns)
				const sx = kappa / KP, sy = ( vy / Vn ) / AP;
				const sl = Math.hypot( sx, sy );
				let Fx = 0, Fy = 0;
				if ( sl > 1e-6 ) {

					// arcade: force stays at its peak past the limit, so slides are long and controllable
					const Fm = Fz * mu * ( arcade ? Math.tanh( 1.9 * sl ) : Math.sin( TC * Math.atan( TB * sl ) ) );
					Fx = Fm * sx / sl;
					Fy = - Fm * sy / sl;

				}
				const stop = Math.abs( vy ) * ( this.mass / 4 ) / dt * 0.8;
				if ( Math.abs( Fy ) > stop ) Fy = Math.sign( Fy ) * stop;
				w.slide = Math.min( 1, Math.abs( vy ) / 6 + Math.max( 0, Math.abs( kappa ) - 0.2 ) );

				if ( w.surf === 0 || w.surf === 3 ) Fx -= Math.sign( vx ) * Math.min( Math.abs( vx ) * 400, Fz * 0.035 ); // grass and gravel drag
				const total = up.clone().multiplyScalar( w.Fs ).addScaledVector( f, Fx ).addScaledVector( side, Fy );
				F.add( total );
				T.add( new V3().crossVectors( r, total ) );

			}

		}

		// aero drag + rolling resistance
		const sp = this.vel.length();
		F.addScaledVector( this.vel, - ( this.spec.cda || 0.4 ) * sp - 0.012 * this.mass * G / Math.max( 1, sp ) * Math.min( 1, sp ) );

		// ---------- integrate ----------
		this.vel.addScaledVector( F, dt / this.mass );
		const tl = T.clone().applyQuaternion( t.q.copy( this.quat ).invert() );
		tl.set( tl.x / this.inertia.x, tl.y / this.inertia.y, tl.z / this.inertia.z ).applyQuaternion( this.quat );
		this.angVel.addScaledVector( tl, dt ).multiplyScalar( 1 - 0.3 * dt );
		this.pos.addScaledVector( this.vel, dt );
		const wq = new THREE.Quaternion( this.angVel.x * dt * 0.5, this.angVel.y * dt * 0.5, this.angVel.z * dt * 0.5, 0 ).multiply( this.quat );
		this.quat.set( this.quat.x + wq.x, this.quat.y + wq.y, this.quat.z + wq.z, this.quat.w + wq.w ).normalize();

		this.collide();

	}

	// ---------- arcade: a forgiving drift model ----------
	// Suspension stays physical (pitch, roll, bumps, jumps). The tyres are replaced by a yaw-rate controller:
	// with grip the car turns like a well set-up road car; the handbrake, a flick or power on in a RWD/AWD car
	// starts a slide, and in a slide the stick sets the slide angle (steer into the turn = wider, counter-steer = out).
	arcadeForces( dt, inp, F, T, contacts, up, fwd, throttle, brake, hand, wheelT ) {

		const W = this.wheels, S = this.spec, world = this.world, R = this.radius;
		const t = this._a || ( this._a = { n: new V3(), f: new V3(), s: new V3(), r: new V3(), x: new V3(), y: new V3() } );
		for ( const w of contacts ) {

			// suspension along the body up axis, at the contact point
			const r = t.r.copy( w.cp ).sub( this.pos );
			const fs = t.x.copy( up ).multiplyScalar( w.Fs );
			F.add( fs );
			T.add( t.y.crossVectors( r, fs ) );
			w.surf = world.surface( w.cp.x, w.cp.z );

		}

		const nC = contacts.length;
		const steer = inp.steer;
		if ( nC === 0 ) {

			// airborne: keep the car roughly level so it lands on its wheels
			const lev = t.x.crossVectors( up, t.y.set( 0, 1, 0 ) );
			T.addScaledVector( lev, this.inertia.x * 3 );
			T.addScaledVector( this.angVel, - this.inertia.x * 0.8 );
			for ( const w of W ) { if ( hand && ! w.front ) w.omega = 0; w.slide = 0; }
			this.drifting = false;
			return;

		}

		const n = t.n.set( 0, 0, 0 );
		for ( const w of contacts ) n.add( w.nrm );
		n.normalize();
		const f = t.f.copy( fwd ).addScaledVector( n, - n.dot( fwd ) ).normalize();
		const s = t.s.crossVectors( n, f ); // left
		const vF = this.vel.dot( f ), vL = this.vel.dot( s ), sp = Math.hypot( vF, vL );
		let load = 0, mu = 0;
		for ( const w of contacts ) { load += w.Fs; mu += GRIP[ w.surf ]; }
		mu = mu / nC * ( S.grip || 1 );
		load = Math.min( 1.4, load / ( this.mass * G ) ) * Math.min( 1, nC / 2.5 );
		const yawRate = this.angVel.dot( n );
		const slip = sp > 2 && vF > 0 ? Math.atan2( - vL, vF ) : 0; // + = nose left of the direction of travel
		this.slip = slip;
		const awd = S.drive === 'awd', fwdD = S.drive === 'fwd';

		// ---- longitudinal: engine through the driven wheels, traction limited ----
		const share = awd ? ( hand ? 0.55 : 1 ) : fwdD ? 0.62 : 0.56;
		const cap = mu * this.mass * G * load * share * 1.05;
		const Fd = wheelT / R;
		const spin = cap > 1 ? Math.abs( Fd ) / cap : 0;
		let Fx = Math.max( - cap, Math.min( cap, Fd ) );
		const gBrake = mu * this.mass * G * load;
		if ( Math.abs( vF ) > 0.3 ) Fx -= Math.sign( vF ) * ( brake * gBrake * 1.0 + ( hand ? gBrake * 0.16 : 0 ) );
		else if ( brake > 0.05 || hand || ( this.auto && throttle < 0.05 && this.gear !== 0 ) ) Fx -= vF * this.mass * 6;

		// ---- drift state ----
		const lock = 0.62 / ( 1 + sp / 14 );
		const wb = S.axle[ 0 ] - S.axle[ 1 ];
		const aMax = mu * load * G * 1.02;
		let rWant = vF * Math.tan( steer * lock ) / wb;
		const rMax = aMax / Math.max( 4, Math.abs( vF ) );
		const over = Math.abs( rWant ) / ( rMax + 1e-3 );
		if ( ! this.drifting && vF > 5.5 ) {

			let enter = 0;
			if ( hand && Math.abs( steer ) > 0.15 ) enter = Math.sign( steer );
			else if ( ! fwdD && throttle > 0.8 && Math.abs( steer ) > 0.55 && vF < 32 && this.gear <= 3 ) enter = Math.sign( steer );
			else if ( over > 1.5 && vF > 13 && throttle < 0.15 ) enter = Math.sign( steer ); // lift-off flick
			else if ( Math.abs( slip ) > 0.22 ) enter = Math.sign( slip );
			if ( enter ) {

				this.drifting = true;
				this.driftDir = enter;
				this.driftT = 0;
				// a kick of rotation so the rear steps out right away
				this.angVel.addScaledVector( n, enter * ( hand ? 0.9 : 0.55 ) );

			}

		}

		let targetSlip = 0, latGrip = 1;
		if ( this.drifting ) {

			this.driftT += dt;
			if ( Math.abs( slip ) > 0.12 ) this.driftDir = Math.sign( slip );
			const dir = this.driftDir;
			const into = Math.max( - 1, Math.min( 1, steer * dir ) );
			const power = fwdD ? 0.12 : awd ? 0.22 : 0.32;
			let ang = 0.42 + 0.32 * into + power * throttle;
			if ( hand ) ang = Math.max( ang, 0.75 );
			if ( into < - 0.35 ) ang = 0.04; // counter-steer: straighten out
			if ( ! hand && throttle < 0.1 && into < 0.3 ) ang = Math.min( ang, 0.18 ); // lift and no steer: the car settles
			targetSlip = dir * Math.max( 0.03, Math.min( 1.05, ang ) );
			latGrip = 0.42 + 0.2 * ( 1 - throttle ) + ( into < - 0.35 ? 0.3 : 0 );
			if ( ( Math.abs( slip ) < 0.07 && this.driftT > 0.35 && ! hand ) || vF < 4 ) this.drifting = false;

		}

		// ---- yaw ----
		const vYaw = Math.atan2( this.vel.dot( t.x.set( 1, 0, 0 ) ), this.vel.dot( t.y.set( 0, 0, 1 ) ) );
		let rV = 0;
		if ( this._vYaw !== undefined && sp > 2 ) { let d = vYaw - this._vYaw; d = Math.atan2( Math.sin( d ), Math.cos( d ) ); rV = d / dt; }
		this._vYaw = vYaw;
		this._rV = ( this._rV || 0 ) + ( rV - ( this._rV || 0 ) ) * Math.min( 1, dt * 20 );
		let rT, k;
		if ( this.drifting ) {

			rT = this._rV + ( targetSlip - slip ) * 4.5;
			k = 9;

		} else {

			// grip: steering sets the yaw rate, limited by what the tyres can hold (a touch of oversteer allowed)
			rT = Math.max( - rMax * 1.04, Math.min( rMax * 1.04, rWant ) );
			k = sp < 1 ? 4 : 10;

		}

		const Tyaw = Math.max( - 14, Math.min( 14, ( rT - yawRate ) * k ) ) * this.inertia.y * Math.min( 1, load * 1.5 );
		T.addScaledVector( n, Tyaw );

		// ---- lateral: kill sideways speed up to what the tyres can hold ----
		const FyMax = aMax * this.mass * latGrip * ( hand && ! this.drifting ? 0.6 : 1 );
		const Fy = Math.max( - FyMax, Math.min( FyMax, - vL * this.mass * ( this.drifting ? 3 : 14 ) ) );

		// keep the speed in a slide when on the throttle (arcade feel)
		if ( this.drifting && sp > 3 ) F.addScaledVector( this.vel, throttle * this.mass * ( fwdD ? 1.8 : 3.4 ) * Math.min( 1, Math.abs( slip ) * 2 ) / sp );

		const Fl = t.x.copy( f ).multiplyScalar( Fx ).addScaledVector( s, Fy );
		F.add( Fl );
		// forces act at the contact patch height: body roll in turns, dive under braking, squat on power
		T.add( t.y.crossVectors( t.r.copy( n ).multiplyScalar( - 0.32 ), Fl ) );

		// ---- wheels: spin for the rev counter, the tyre marks and the sound ----
		const tyreSpin = this.drifting ? 0.15 + throttle * 0.35 : spin > 1 ? Math.min( 0.8, ( spin - 1 ) * 0.6 ) : 0;
		const latSat = Math.min( 1, Math.abs( vL * this.mass * 14 ) / ( FyMax + 1 ) );
		for ( const w of W ) {

			const driven = awd || ( fwdD ? w.front : ! w.front );
			let om = vF / R;
			if ( driven && Fd * vF >= 0 ) om *= 1 + tyreSpin;
			if ( hand && ! w.front ) om = 0;
			w.omega = om;
			if ( ! w.contact ) { w.slide = 0; continue; }
			let sl = 0;
			if ( this.drifting ) sl = Math.min( 1, Math.abs( slip ) * ( w.front ? 0.7 : 1.9 ) + 0.15 );
			else if ( latSat > 0.95 ) sl = ( latSat - 0.95 ) * 4;
			if ( driven && tyreSpin > 0.05 ) sl = Math.max( sl, Math.min( 1, tyreSpin * 1.8 ) );
			if ( hand && ! w.front && Math.abs( vF ) > 2 ) sl = Math.max( sl, 0.8 );
			if ( brake > 0.9 && Math.abs( vF ) > 8 ) sl = Math.max( sl, 0.45 );
			if ( w.surf === 0 || w.surf === 3 ) sl *= 0.6;
			w.slide = sl;
			w.kappa = 0;

		}

	}

	// body spheres vs buildings and terrain
	collide() {

		const world = this.world;
		const cp = new V3();
		for ( const s of this.spheres ) {

			const c = s.clone().applyQuaternion( this.quat ).add( this.pos );
			// buildings
			const hit = world.closest( c, 0.62, cp );
			if ( hit && hit.distance > 1e-4 ) {

				const n = c.clone().sub( cp ).divideScalar( hit.distance );
				this.resolve( c, n, 0.62 - hit.distance, 0.15, 0.35 );

			}

			// trees: big enough hit knocks them over, otherwise they act like a post
			for ( const tr of this.trees || [] ) {

				if ( c.y > tr.y + tr.h || c.y < tr.y - 1 ) continue;
				const dx = c.x - tr.x, dz = c.z - tr.z, d = Math.hypot( dx, dz ), min = 0.6 + tr.r;
				if ( d >= min || d < 1e-4 ) continue;
				const n = new V3( dx / d, 0, dz / d );
				const vn = this.vel.dot( n );
				if ( - vn > 2.5 + tr.h * 0.25 ) {

					const sp = Math.hypot( this.vel.x, this.vel.z ) || 1;
					world.fellTree( tr, this.vel.x / sp, this.vel.z / sp );
					this.vel.multiplyScalar( 1 - 0.25 * Math.min( 1, tr.h / 20 ) );
					this.impact = Math.max( this.impact, 0.35 );

				} else this.resolve( c, n, min - d, 0.2, 0.3 );

			}

			// ground (only when the body itself touches it, e.g. upside down)
			const gy = world.ground( c.x, c.z, c.y );
			if ( c.y - 0.32 < gy ) {

				const n = world.groundNormal( c.x, c.z, c.y, new V3() );
				this.resolve( c, n, ( gy - ( c.y - 0.32 ) ) * n.y, 0.05, 0.6 );

			}

		}

	}

	resolve( point, n, pen, e, fr ) {

		this.pos.addScaledVector( n, Math.min( pen, 0.4 ) );
		const r = point.clone().sub( this.pos );
		const v = new V3().crossVectors( this.angVel, r ).add( this.vel );
		const vn = v.dot( n );
		if ( vn >= 0 ) return;
		const qi = this._t.q.copy( this.quat ).invert();
		const invI = x => {

			const l = x.clone().applyQuaternion( qi );
			return l.set( l.x / this.inertia.x, l.y / this.inertia.y, l.z / this.inertia.z ).applyQuaternion( this.quat );

		};

		const rn = new V3().crossVectors( r, n );
		const k = 1 / this.mass + n.dot( new V3().crossVectors( invI( rn ), r ) );
		const j = - ( 1 + e ) * vn / k;
		// friction impulse
		const vt = v.clone().addScaledVector( n, - vn );
		const vtl = vt.length();
		const J = n.clone().multiplyScalar( j );
		if ( vtl > 1e-3 ) J.addScaledVector( vt, - Math.min( fr * j, vtl * this.mass * 0.5 ) / vtl );
		this.vel.addScaledVector( J, 1 / this.mass );
		this.angVel.add( invI( new V3().crossVectors( r, J ) ) );
		if ( - vn > 4 ) this.impact = Math.max( this.impact, Math.min( 1, - vn / 15 ) );

	}

}
