// Set the rocket's rotation from pitch, yaw, roll (degrees)
function setRocket3DRotation(pitch, yaw, roll) {
    if (!rocket3dModel) return;
    // Swapped X/Z for correct orientation
    rocket3dModel.rotation.order = 'ZYX'; // yaw→pitch→roll

    // Rotation of the rocket model
    rocket3dModel.rotation.z = THREE.MathUtils.degToRad(roll || 0);  // roll (IMU Z)
    rocket3dModel.rotation.y = THREE.MathUtils.degToRad(pitch || 0); // pitch (IMU Y)
    rocket3dModel.rotation.x = THREE.MathUtils.degToRad(yaw || 0);   // yaw (IMU X)
}

let rocket3dScene, rocket3dCamera, rocket3dRenderer, rocket3dModel, axesGroup;

function initRocket3D() {
    const container = document.getElementById('rocket3dContainer');
    rocket3dScene = new THREE.Scene();
    rocket3dCamera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    rocket3dCamera.position.set(0, 0, 4.2);

    rocket3dRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    rocket3dRenderer.setClearColor(0xffffff, 0);
    if (typeof rocket3dRenderer.setClearAlpha === 'function') rocket3dRenderer.setClearAlpha(0);
    rocket3dRenderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(rocket3dRenderer.domElement);

    // ---------- Rocket ----------
    const rocketGroup = new THREE.Group();

    const bodyGeometry = new THREE.CylinderGeometry(0.2, 0.2, 2.2, 32);
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    rocketGroup.add(body);

    const noseGeometry = new THREE.ConeGeometry(0.22, 0.5, 32);
    const noseMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const nose = new THREE.Mesh(noseGeometry, noseMaterial);
    nose.position.y = 1.35;
    rocketGroup.add(nose);

    const finGeometry = new THREE.BoxGeometry(0.05, 0.4, 0.18);
    const finMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    for (let i = 0; i < 3; i++) {
        const fin = new THREE.Mesh(finGeometry, finMaterial);
        fin.position.y = -1.1;
        fin.position.x = Math.cos((i * 2 * Math.PI) / 3) * 0.18;
        fin.position.z = Math.sin((i * 2 * Math.PI) / 3) * 0.18;
        fin.rotation.y = (i * 2 * Math.PI) / 3;
        rocketGroup.add(fin);
    }

    // Rotate rocket 90° so it points along X instead of Y
    rocketGroup.rotation.z = -Math.PI / 2;

    rocketGroup.scale.set(1.3, 1.3, 1.3);
    rocket3dScene.add(rocketGroup);
    rocket3dModel = rocketGroup;

    // ---------- Fixed world axes (bigger & slightly lower) ----------
    const axesLength = 1.8;
    const axesRadius = 0.08;
    const axesOpacity = 0.7;

    axesGroup = new THREE.Group();

    // X axis (forward) - red 0x00ff00
    const xMat = new THREE.MeshBasicMaterial({ color: 0x00ff00  , transparent: true, opacity: axesOpacity, depthTest: false });
    const xGeom = new THREE.CylinderGeometry(axesRadius, axesRadius, axesLength, 16);
    const xAxis = new THREE.Mesh(xGeom, xMat);
    xAxis.position.set(axesLength / 2, -1.5, 0);
    xAxis.rotation.z = Math.PI / 2;
    axesGroup.add(xAxis);

    // Y axis (right) - green
    const yMat = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: axesOpacity, depthTest: false });
    const yGeom = new THREE.CylinderGeometry(axesRadius, axesRadius, axesLength, 16);
    const yAxis = new THREE.Mesh(yGeom, yMat);
    yAxis.position.set(0, -1.5 + axesLength / 2, 0);
    axesGroup.add(yAxis);

    // Z axis (up) - blue
    const zMat = new THREE.MeshBasicMaterial({ color: 0x0000ff, transparent: true, opacity: axesOpacity, depthTest: false });
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
        const width = container.clientWidth;
        const height = container.clientHeight;
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
