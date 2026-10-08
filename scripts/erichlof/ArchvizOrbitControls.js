// Orbit / pan / zoom controls for erichlof's demo (classic script, loaded after InitCommon.js and the demo).
// Replaces the demo's pointer-lock fly camera, whose every mouse twitch restarted accumulation.
//   Mouse: left-drag orbit · right-drag, middle-drag or shift+drag pan · wheel zoom · double-click re-frame
//   Touch: one finger orbit · two fingers pan + pinch zoom
// Works on the demo's own globals: cameraControlsObject / cameraControlsYawObject / cameraControlsPitchObject,
// cameraIsMoving, meshes, modelScale, modelPositionOffset, updateVariablesAndUniforms.
(function () {
	// Never engage pointer lock (the fly camera); keyboard/mouse-look listeners stay inactive while unlocked.
	HTMLElement.prototype.requestPointerLock = function () {};

	const target = new THREE.Vector3();
	let radius = 100, theta = 0, phi = 0.3; // phi = elevation angle
	let minRadius = 5, maxRadius = 2000;
	let initialised = false, dirty = false;
	let home = null;

	function frameModel() {
		// model bounds as the demo bakes them (geometry in metres × modelScale + offset)
		const box = new THREE.Box3();
		for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
		box.min.multiplyScalar(modelScale).add(modelPositionOffset);
		box.max.multiplyScalar(modelScale).add(modelPositionOffset);
		const center = box.getCenter(new THREE.Vector3());
		const size = box.getSize(new THREE.Vector3()).length();
		minRadius = size * 0.05; maxRadius = size * 6;
		return { center, size };
	}

	function initFromCamera() {
		const { center } = frameModel();
		const pos = cameraControlsObject.position;
		target.copy(center);
		const offset = pos.clone().sub(target);
		radius = offset.length();
		theta = Math.atan2(offset.x, offset.z);
		phi = Math.asin(THREE.MathUtils.clamp(offset.y / radius, -1, 1));
		home = { target: target.clone(), radius, theta, phi };
		initialised = true;
		dirty = true;
	}

	function apply() {
		phi = THREE.MathUtils.clamp(phi, 0.02, Math.PI / 2 - 0.02); // stay above the ground
		radius = THREE.MathUtils.clamp(radius, minRadius, maxRadius);
		const c = Math.cos(phi);
		cameraControlsObject.position.set(
			target.x + radius * Math.sin(theta) * c,
			target.y + radius * Math.sin(phi),
			target.z + radius * Math.cos(theta) * c);
		cameraControlsYawObject.rotation.y = theta;   // looking back at the target
		cameraControlsPitchObject.rotation.x = -phi;
	}

	function pan(dx, dy) {
		// move target along the camera's right/up vectors, scaled so the model tracks the cursor
		const fov = THREE.MathUtils.degToRad(worldCamera.fov);
		const scale = (2 * radius * Math.tan(fov / 2)) / window.innerHeight;
		const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
		const up = new THREE.Vector3(-Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta));
		target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
	}

	// Run inside the demo's frame, after it clears cameraIsMoving and before it updates the sample counter.
	const demoUpdate = updateVariablesAndUniforms;
	updateVariablesAndUniforms = function () {
		if (!initialised && meshes.length) initFromCamera();
		if (dirty) { apply(); cameraIsMoving = true; dirty = false; }
		demoUpdate();
	};

	// ------------------------------------------------------------------ input
	const el = document.getElementById('container');
	const pointers = new Map();
	let mode = null, lastPinch = 0, lastMid = null;

	el.addEventListener('contextmenu', (e) => e.preventDefault());
	el.addEventListener('pointerdown', (e) => {
		el.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) mode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit';
		if (pointers.size === 2) {
			mode = 'touch2';
			const [a, b] = [...pointers.values()];
			lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
			lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		}
	});
	el.addEventListener('pointermove', (e) => {
		const p = pointers.get(e.pointerId);
		if (!p || !initialised) return;
		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;
		if (mode === 'orbit') { theta -= dx * 0.005; phi += dy * 0.005; }
		else if (mode === 'pan') pan(dx, dy);
		else if (mode === 'touch2' && pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			if (lastPinch) radius *= lastPinch / dist;
			pan(mid.x - lastMid.x, mid.y - lastMid.y);
			lastPinch = dist; lastMid = mid;
		}
		dirty = true;
	});
	const up = (e) => {
		pointers.delete(e.pointerId);
		if (pointers.size === 0) mode = null;
		else if (pointers.size === 1) mode = 'orbit';
	};
	el.addEventListener('pointerup', up);
	el.addEventListener('pointercancel', up);
	el.addEventListener('wheel', (e) => {
		e.preventDefault();
		radius *= Math.exp(e.deltaY * 0.001);
		dirty = true;
	}, { passive: false });
	el.addEventListener('dblclick', () => {
		if (!home) return;
		target.copy(home.target); radius = home.radius; theta = home.theta; phi = home.phi;
		dirty = true;
	});
	el.style.touchAction = 'none';
	el.style.cursor = 'grab';
})();
