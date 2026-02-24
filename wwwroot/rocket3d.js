// Set the rocket's rotation from pitch, yaw, roll (degrees)
function setRocket3DRotation(pitch, yaw, roll) {
    if (!rocket3dModel) return;

    // Swapped X/Z for correct orientation
    rocket3dModel.rotation.order = 'ZYX'; // yaw -> pitch -> roll

    // Rotation of the rocket model
    rocket3dModel.rotation.z = THREE.MathUtils.degToRad(pitch || 0); // roll (IMU Z)
    rocket3dModel.rotation.y = THREE.MathUtils.degToRad(yaw || 0);   // pitch (IMU Y)
    rocket3dModel.rotation.x = THREE.MathUtils.degToRad(roll || 0);  // yaw (IMU X)
}

let rocket3dScene, rocket3dCamera, rocket3dRenderer, rocket3dModel, axesGroup;
const ROCKET_VIEW_SIZE = 160;

function initRocket3D() {
    const container = document.getElementById('rocket3dContainer');
    if (!container) return;

    container.innerHTML = '';

    const initialWidth = container.clientWidth || ROCKET_VIEW_SIZE;
    const initialHeight = container.clientHeight || ROCKET_VIEW_SIZE;

    rocket3dScene = new THREE.Scene();
    rocket3dCamera = new THREE.PerspectiveCamera(60, initialWidth / initialHeight, 0.1, 1000);
    rocket3dCamera.position.set(0, 0, 4.2);

    rocket3dRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rocket3dRenderer.setClearColor(0xffffff, 0);
    if (typeof rocket3dRenderer.setClearAlpha === 'function') rocket3dRenderer.setClearAlpha(0);
    rocket3dRenderer.setSize(initialWidth, initialHeight);
    container.appendChild(rocket3dRenderer.domElement);

    // ---------- Rocket ----------
    const rocketGroup = new THREE.Group();

    const bodyGeometry = new THREE.CylinderGeometry(0.2, 0.2, 2.2, 32);
    const bodyMaterial = new THREE.MeshStandardMaterial({
        color: 0xd9dde3,
        roughness: 0.62,
        metalness: 0.06
    });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    rocketGroup.add(body);

    const noseGeometry = new THREE.ConeGeometry(0.2, 0.5, 32);
    const noseMaterial = bodyMaterial;
    const nose = new THREE.Mesh(noseGeometry, noseMaterial);
    nose.position.y = 1.35;
    rocketGroup.add(nose);

    // Nozzle
    const nozzleGeom = new THREE.CylinderGeometry(0.2, 0.11, 0.25, 32);
    const nozzleMat = new THREE.MeshStandardMaterial({ color: 0xb6bdc8, roughness: 0.5, metalness: 0.2 });
    const nozzle = new THREE.Mesh(nozzleGeom, nozzleMat);
    nozzle.position.y = -1.25;
    rocketGroup.add(nozzle);

    // ---------- Trapezoid fins (realistic preset) ----------
    function makeTrapezoidFinGeometry(rootChord, tipChord, span, thickness, sweep) {
        // Fin plane is X/Y:
        // X = radial direction (out from body), Y = rocket axis direction.
        // Root edge (long) is at X=0, tip edge (short) is at X=span.
        const rootHalf = rootChord * 0.5;
        const tipHalf = tipChord * 0.5;
        const shape = new THREE.Shape();
        shape.moveTo(0, -rootHalf);
        shape.lineTo(0, rootHalf);
        shape.lineTo(span, sweep + tipHalf);
        shape.lineTo(span, sweep - tipHalf);
        shape.closePath();

        const geom = new THREE.ExtrudeGeometry(shape, {
            depth: thickness,
            bevelEnabled: false
        });

        // Center only thickness on Z so root stays anchored at local X=0.
        geom.translate(0, 0, -thickness * 0.5);
        geom.computeVertexNormals();
        return geom;
    }

    const finMaterial = new THREE.MeshStandardMaterial({
        color: 0x8b95a3,
        roughness: 0.5,
        metalness: 0.2,
        flatShading: true,
        side: THREE.DoubleSide
    });
    const finEdgeMaterial = new THREE.LineBasicMaterial({
        color: 0x4f5b6b,
        transparent: true,
        opacity: 0.7
    });

    const bodyRadius = 0.20;
    const rootChord = 0.32;
    const tipChord = 0.10;
    const span = 0.20;
    const thickness = 0.03;
    // Keep fin centered so it looks like a full trapezoid from side view.
    const sweep = 0.0;

    const finGeom = makeTrapezoidFinGeometry(rootChord, tipChord, span, thickness, sweep);

    for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(finGeom, finMaterial);
        const angle = (i * Math.PI * 2) / 4;
        const out = bodyRadius + 0.003;

        fin.position.set(Math.cos(angle) * out, -0.9, Math.sin(angle) * out);
        fin.rotation.y = angle;
        fin.add(new THREE.LineSegments(new THREE.EdgesGeometry(finGeom), finEdgeMaterial));

        rocketGroup.add(fin);
    }

    // Rotate rocket 90 deg so it points along X instead of Y
    rocketGroup.rotation.z = -Math.PI / 2;

    rocketGroup.scale.set(1.3, 1.3, 1.3);
    rocket3dScene.add(rocketGroup);
    rocket3dModel = rocketGroup;

    // ---------- Fixed world axes (bigger & slightly lower) ----------
    const axesLength = 1.8;
    const axesRadius = 0.08;
    const axesOpacity = 0.35;

    axesGroup = new THREE.Group();

    // X axis (forward) - red
    const xMat = new THREE.MeshBasicMaterial({
        color: 0xff0000,
        transparent: true,
        opacity: axesOpacity,
        depthTest: true
    });
    const xGeom = new THREE.CylinderGeometry(axesRadius, axesRadius, axesLength, 16);
    const xAxis = new THREE.Mesh(xGeom, xMat);
    xAxis.position.set(axesLength / 2, -1.5, 0);
    xAxis.rotation.z = Math.PI / 2;
    axesGroup.add(xAxis);

    // Y axis (right) - green
    const yMat = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: axesOpacity,
        depthTest: true
    });
    const yGeom = new THREE.CylinderGeometry(axesRadius, axesRadius, axesLength, 16);
    const yAxis = new THREE.Mesh(yGeom, yMat);
    yAxis.position.set(0, -1.5 + axesLength / 2, 0);
    axesGroup.add(yAxis);

    // Z axis (up) - blue
    const zMat = new THREE.MeshBasicMaterial({
        color: 0x0000ff,
        transparent: true,
        opacity: axesOpacity,
        depthTest: true
    });
    const zGeom = new THREE.CylinderGeometry(axesRadius, axesRadius, axesLength, 16);
    const zAxis = new THREE.Mesh(zGeom, zMat);
    zAxis.position.set(0, -1.5, axesLength / 2);
    zAxis.rotation.x = -Math.PI / 2;
    axesGroup.add(zAxis);

    // Slightly below rocket base
    axesGroup.position.set(0, -0.4, 0);
    rocket3dScene.add(axesGroup);

    // ---------- Lighting ----------
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    rocket3dScene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(5, 5, 5);
    rocket3dScene.add(dirLight);

    // ---------- Resize ----------
    function onResize() {
        const width = container.clientWidth || ROCKET_VIEW_SIZE;
        const height = container.clientHeight || ROCKET_VIEW_SIZE;
        rocket3dCamera.aspect = width / height;
        rocket3dCamera.updateProjectionMatrix();
        rocket3dRenderer.setSize(width, height);
    }

    window.addEventListener('resize', onResize);
    onResize();
    animateRocket3D();
}

function animateRocket3D() {
    requestAnimationFrame(animateRocket3D);
    rocket3dRenderer.render(rocket3dScene, rocket3dCamera);
}



