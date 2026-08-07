import { 
	Ion, Viewer, Cartesian3, Color, JulianDate, ClockRange, PointPrimitiveCollection, ScreenSpaceEventHandler, 
	ScreenSpaceEventType, NearFarScalar, CallbackProperty, BoundingSphere, PolylineCollection, Material, UrlTemplateImageryProvider, 
	ImageryLayer, knockout 
} from 'cesium';
import { twoline2satrec, gstime, eciToGeodetic, propagate } from "satellite.js";
import { inject } from "@vercel/analytics";
import { injectSpeedInsights } from "@vercel/speed-insights";
import SatWorker from "/helpers/SatWorker.js?worker";
import Countries from "../data/Countries.json";
import Sites from "../data/Sites.json";

inject();
injectSpeedInsights();

// Setup viewport and variables
Ion.defaultAccessToken = import.meta.env.VITE_token;
const viewer = new Viewer('cesiumContainer', {
	//baseLayer: new ImageryLayer(new UrlTemplateImageryProvider({
	//	url: `https://api.maptiler.com/maps/hybrid-v4/{z}/{x}/{y}.jpg?key=${import.meta.env.VITE_MAPTILER_KEY}`
	//})),
	baseLayerPicker: false,
	fullScreenButton: false,
	vrButton: false,
	infoBox: false,
	homeButton: false,
	navigationHelpButton: false,
	geocoder: false,
	fullscreenButton: false,
	projectionPicker: false,
	sceneModePicker: false,
	skyAtmosphere: false,
	shouldAnimate: true,
	requestRenderMode: true,
	scene3DOnly: true,
});
viewer.resolutionScale = window.devicePixelRatio;
viewer.scene.screenSpaceCameraController.maximumZoomDistance = 5e8;
viewer.scene.globe.showGroundAtmosphere = false;
viewer.scene.globe.enableLighting = false;
viewer.scene.atmosphere.show = false;
viewer.scene.fog.enabled = false;

const ClickAOE = 3;
const PageLength = 50;
const FFSpeedLimit = 10;
const DateRange = 1 * 24 * 60 * 60 * 1000;
const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
const Points = viewer.scene.primitives.add(new PointPrimitiveCollection());
const PointsMap = new Map();
const DetailMap = new Map();
const ScalingScalar = new NearFarScalar(1.0e5, 1.0, 2.0e7, 0.2);
const Worker = new SatWorker();
const TrackingEntity = viewer.entities.add({
	id: "Tracker",
	position: new CallbackProperty((time, res) => {
		if (TrackingId) return PointsMap.get(TrackingId).position;
		return undefined;
	}, false),
	viewFrom: new Cartesian3(0, -500000, 500000),
	point: { pixelSize: 0 }
});
const HoverHighlight = Points.add({
	position: Cartesian3.ZERO,
	color: Color.TRANSPARENT,
	outlineColor: Color.LIME,
	outlineWidth: 2,
	pixelSize: 20,
	show: false,
	id: "HoverHighlight"
});

let ImageNames = [];
let CountryToSites = new Map();
let PageIndex = 0;
let ActiveIds = null;
let TrackingId = null;
let MousePosition = null;
let LastUpdate = 0;
let UpdateInterval = 100;

// Position interpolation
const CacheDuration = 30000;
const SafetyBuffer = 5000;
let CacheT0 = 0;
let CacheT1 = 0;
let CacheOffset = 0;
let WorkerBusy = false;
let PositionsBuffer = null;
let WorkerBuffer = null;
let PositionsArray = null;
const TempPos = new Cartesian3();

// Orbit Lines
const Orbits = viewer.scene.primitives.add(new PolylineCollection());
const OrbitLine = Orbits.add({
	width: 3,
	material: Material.fromType("Color", { color: Color.RED })
});
const OrbitalSamples = 100;

// Override speed
knockout.getObservable(viewer.clockViewModel, 'multiplier').subscribe((speed) => {
    if (Math.abs(speed) > FFSpeedLimit) {
    	const clamped = Math.sign(speed) * FFSpeedLimit;
    	viewer.clockViewModel.multiplier = clamped;
    	viewer.clock.multiplier = clamped;
    }
  });

async function Init() {
	// Get the list of images
	const ImageReq = await fetch('/Satellites/ImageNames.json');
	ImageNames = await ImageReq.json();
	
	// Set up the countries dropdown
	const Options = document.getElementById('CountryOptions');
	const SelectAll = document.createElement('label');
	SelectAll.className = 'MultiselectItem';
	SelectAll.innerHTML = `
		<input type="checkbox" value="All" id="CountrySelectAll" checked onclick="CountrySelectAll()">
		<span>Select All</span>
	`;
	Options.append(SelectAll);

	Object.entries(Countries).forEach(([code, name]) => {
		const label = document.createElement('label');
		label.className = 'MultiselectItem';
		label.innerHTML = `
            <input type="checkbox" value="${code}" checked onchange="UpdateCountrySelection()">
            <span>${name}</span>
        `;
		Options.append(label);
	});

	// Get the initial catalog of data
	console.log('Fetching initial data');
	const CatalogReq = await fetch('/api/FetchInitial');
	const CatalogRes = await CatalogReq.json();

	// Initialize the local catalog
	console.log('Initializing satellites');
	const SatrecMap = new Map();
	CatalogRes.forEach(sat => {
		// Initialize the country to launch site mapping
		sat.country = sat.country ?? "null";
		if (!sat.launch_site) sat.launch_site = "Unknown";

		if (!CountryToSites.has(sat.country)) 
			CountryToSites.set(sat.country, new Set());
		CountryToSites.get(sat.country).add(sat.launch_site);

		SatrecMap.set(sat.norad_id, twoline2satrec(sat.tle_line1, sat.tle_line2));
		const Point = Points.add({
			position: Cartesian3.ZERO,
			color: Color.fromCssColorString('#00a8ff').withAlpha(0.8),
			pixelSize: 12,
			scaleByDistance: ScalingScalar,
			id: sat.norad_id
		});
		PointsMap.set(sat.norad_id, Point);
		DetailMap.set(sat.norad_id, sat);
	});
	Worker.postMessage({
		type: "Init",
		data: SatrecMap
	});
	PositionsBuffer = new ArrayBuffer(DetailMap.size * 7 * 8);
	WorkerBuffer = new ArrayBuffer(DetailMap.size * 7 * 8);

	// Clamp date range
	const StartJulian = JulianDate.fromDate(new Date(Date.now() - DateRange));
	const EndJulian = JulianDate.fromDate(new Date(Date.now() + DateRange));
	viewer.clock.startTime = StartJulian;
	viewer.clock.stopTime = EndJulian;
	viewer.clock.clockRange = ClockRange.CLAMPED;
	viewer.timeline.zoomTo(viewer.clock.startTime, viewer.clock.stopTime);

	// Initial search
	window.UpdateCountrySelection();
	await window.Search();
	viewer.scene.preUpdate.addEventListener(TickUpdate);
	document.getElementById('LoadingOverlay').remove();
}

function TickUpdate(scene, time) {
	const CurrTime = JulianDate.toDate(time).getTime();

	// Run interpolation
	const blend = (CurrTime - CacheT0) / CacheDuration;
	for (let i = 0; i < CacheOffset; i += 7) {
		const pt = PointsMap.get(PositionsArray[i]);
		TempPos.x = PositionsArray[i+1] + (blend * (PositionsArray[i+4] - PositionsArray[i+1]));
		TempPos.y = PositionsArray[i+2] + (blend * (PositionsArray[i+5] - PositionsArray[i+2]));
		TempPos.z = PositionsArray[i+3] + (blend * (PositionsArray[i+6] - PositionsArray[i+3]));
		pt.position = TempPos;
	}

	if (CurrTime < LastUpdate + UpdateInterval && CurrTime > LastUpdate - UpdateInterval) return;
	LastUpdate = CurrTime;
	
	if (!WorkerBusy && (CurrTime < CacheT0 || CurrTime > CacheT1 - SafetyBuffer)) {
		WorkerBusy = true;
		Worker.postMessage({
			type: 'Compute',
			T0: CurrTime,
			T1: CurrTime + CacheDuration,
			buffer: WorkerBuffer
		}, [WorkerBuffer]);
		WorkerBuffer = null;

		if (TrackingId) {
			Worker.postMessage({
				type: 'CalcDetails',
				id: TrackingId,
				time: CurrTime
			});
			Worker.postMessage({
				type: 'CalcOrbit',
				id: TrackingId,
				time: CurrTime,
				period: DetailMap.get(TrackingId).period,
				samples: OrbitalSamples
			});
		}
	}

	if (MousePosition) {
		const HoveredObjects = viewer.scene.drillPick(
			MousePosition,
			3,
			ClickAOE,
			ClickAOE
		);

		for (const sat of HoveredObjects) {
			if (sat.primitive && sat.primitive.id && sat.primitive.id != "HoverHighlight" && sat.primitive.show) {
				HoverHighlight.position = sat.primitive.position;
				HoverHighlight.show = true;
				viewer.canvas.style.cursor = 'pointer';
				return;
			}
		}

		HoverHighlight.show = false;
		viewer.canvas.style.cursor = 'default';
	}
}

function RenderPage(){
	var SatList = document.getElementById("SearchScroll");
	SatList.innerHTML = "";

	// Adds sat card for each active id
	for (let i = PageIndex * PageLength; i < ActiveIds.length && i < (PageIndex + 1) * PageLength; ++i){
		const detail = DetailMap.get(ActiveIds[i])

		const tab = document.createElement('div');
		tab.className = "SatCard";
		tab.innerHTML = `
			<img src="${GetSatImage(detail.name)}" alt="Satellite">
			<div class="SatCardDetails">
				<span class="SatName">${detail.name}</span>
				<div class="DetailsLine">
					<span class="Country">Country: ${detail.country}</span>
					<span class="Site">Site: ${detail.launch_site}</span>
				</div>
				<div class="DetailsLine">
					<span class="Norad">NORAD: ${detail.norad_id}</span>
					<span class="Site">INTL: ${detail.intl_designator}</span>
					</div>
			</div>
		`;
		tab.onclick = () => SatClicked(ActiveIds[i]);
		SatList.append(tab);
	}

	// Fills in the page index, forst and last index at the bottom
	const first = String(PageIndex * PageLength + 1);
	const last = String(Math.min(ActiveIds.length, (PageIndex + 1) * PageLength));
	const max = String(ActiveIds.length);
	document.getElementById("PageNo").innerText = first + '-' + last + ' / ' + max;
}

function GetSatImage(Name) {
	Name = Name.toUpperCase();
	const match = ImageNames.find(exp => Name.includes(exp));
	return match ? `/Satellites/${match}.png` : '/Satellites/GENERIC.png';
}

Worker.onmessage = function(res) {
	const inp = res.data;
	if (inp.type == 'PositionResult') {
		WorkerBuffer = PositionsBuffer
		PositionsBuffer = inp.buffer;
		CacheT0 = inp.T0;
		CacheT1 = inp.T1;
		CacheOffset = inp.offset;
		PositionsArray = new Float64Array(PositionsBuffer);
		WorkerBusy = false;
	}
	else if (inp.type == 'UpdateStats' && inp.id == TrackingId) {
		document.getElementById("DetailSpeed").textContent = inp.speed + " km/h";
		document.getElementById("DetailHeading").textContent = inp.heading + "°";
		document.getElementById("DetailLatitude").textContent = inp.latitude + "°";
		document.getElementById("DetailLongitude").textContent = inp.longitude + "°";
		document.getElementById("DetailAltitude").textContent = inp.altitude + " km";
	}
	else if (inp.type == 'OrbitResult' && inp.id == TrackingId) {
		const PosArray = new Float64Array(inp.buffer);
		const PosCart = [];
		for (let i = 0; i < inp.offset; i += 3) {
			const cart = Cartesian3.fromRadians(
				PosArray[i],
				PosArray[i + 1], 
				PosArray[i + 2]
			);
			PosCart.push(cart);
		}
		OrbitLine.positions = PosCart;
		OrbitLine.show = true;
	}
}

window.Search = async function (){
	document.getElementById("SearchSubmit").textContent = "Searching...";

	// Initialize all filters
	let Name = document.getElementById("NameSearch").value.trim().toUpperCase();
	let FromDate = document.getElementById("LaunchDateFrom").valueAsDate;
	let ToDate = document.getElementById("LaunchDateTo").valueAsDate;
	let ElementCountries = document.querySelectorAll('#CountryOptions input[type="checkbox"]:checked');
	let ElementSites = document.querySelectorAll('#SiteOptions input[type="checkbox"]:checked');
	let SelectedCountries = new Set();
	let SelectedSites = new Set();

	if (!FromDate) FromDate = new Date(1900, 0, 1);
	if (!ToDate) ToDate = new Date();
	ElementCountries.forEach((cb) => { SelectedCountries.add(cb.value); });
	ElementSites.forEach((cb) => { SelectedSites.add(cb.value); });

	// Run filter
	ActiveIds = [];
	for (const [id, detail] of DetailMap.entries()) {
		PointsMap.get(id).show = false;

		if (!detail.name.toUpperCase().includes(Name)) continue;
		if (!SelectedCountries.has(detail.country)) continue;
		if (!SelectedSites.has(detail.launch_site)) continue;
		if (FromDate > new Date(detail.launch_date)) continue;
		if (ToDate < new Date(detail.launch_date)) continue;

		ActiveIds.push(id);
		PointsMap.get(id).show = true;
	}

	// Untrack if current satellite was filtered
	if (TrackingId && !ActiveIds.includes(TrackingId)) ResetTrack();

	// Sort ids alphabetically
	ActiveIds.sort((A, B) => {
		const NameA = DetailMap.get(A).name;
		const NameB = DetailMap.get(B).name;
		return NameA.localeCompare(NameB);
	});

	// Display the results in the sidebar
	PageIndex = 0;
	RenderPage();
	document.getElementById("SearchSubmit").textContent = "Search";
}

window.SatClicked = async function (SatId) {
	// Deselect
	window.ResetTrack();
	document.getElementById("SatName").textContent = "Loading...";
	
	// Open sidebar
	const Sidebar = document.getElementById('RightSidebar');
	Sidebar.classList.add("open");
	
	// Set all values
	const Detail = DetailMap.get(SatId);
	document.getElementById("SatImg").src = GetSatImage(Detail.name);
	document.getElementById("SatName").textContent = Detail.name;
	document.getElementById("DetailNorad").textContent = Detail.norad_id;
	document.getElementById("DetailIntl").textContent = Detail.intl_designator;
	document.getElementById("DetailDate").textContent = Detail.launch_date.split('T')[0];
	document.getElementById("DetailCountry").textContent = Countries[Detail.country] || Detail.country;
	document.getElementById("DetailSite").textContent = Sites[Detail.launch_site] || Detail.launch_site;
	document.getElementById("DetailApoapsis").textContent = Detail.apoapsis;
	document.getElementById("DetailPeriapsis").textContent = Detail.periapsis;
	document.getElementById("DetailInclination").textContent = Detail.inclination;
	document.getElementById("DetailEccentricity").textContent = Detail.eccentricity;
	document.getElementById("DetailPeriod").textContent = Detail.period;
	
	// Set tracker and smoothly fly there
	TrackingId = SatId;
	viewer.trackedEntity = TrackingEntity;
	viewer.camera.flyToBoundingSphere(
		new BoundingSphere(PointsMap.get(SatId).position, 500000),
		{ duration: 1 }
	);

	// Compute orbital trajectory and details
	const time = JulianDate.toDate(viewer.clock.currentTime).getTime();
	Worker.postMessage({
		type: 'CalcOrbit',
		id: TrackingId,
		time: time,
		period: Detail.period,
		samples: OrbitalSamples
	});

	Worker.postMessage({
		type: 'CalcDetails',
		id: TrackingId,
		time: time
	});
}

window.ResetTrack = function() {
	// Reset details
	document.getElementById("SatImg").src = GetSatImage('Minceraft');
	document.getElementById("SatName").textContent = "No Satellite Selected";
	document.getElementById("DetailNorad").textContent = "";
	document.getElementById("DetailIntl").textContent = "";
	document.getElementById("DetailDate").textContent = "";
	document.getElementById("DetailCountry").textContent = "";
	document.getElementById("DetailSite").textContent = "";
	document.getElementById("DetailApoapsis").textContent = "";
	document.getElementById("DetailPeriapsis").textContent = "";
	document.getElementById("DetailInclination").textContent = "";
	document.getElementById("DetailEccentricity").textContent = "";
	document.getElementById("DetailPeriod").textContent = "";
	document.getElementById("DetailSpeed").textContent = "";
	document.getElementById("DetailHeading").textContent = "";
	document.getElementById("DetailAltitude").textContent = "";
	document.getElementById("DetailLatitude").textContent = "";
	document.getElementById("DetailLongitude").textContent = "";

	// Reset tracking and orbit
	TrackingId = null;
	viewer.trackedEntity = undefined;
	OrbitLine.show = false;
}

window.UpdateCountrySelection = function(){
	const Selected = document.querySelectorAll('#CountryOptions input[type="checkbox"]:checked');
	
	// Get count of selected and total options
	const total = document.querySelectorAll('#CountryOptions input[type="checkbox"]').length - 1;
	let count = Selected.length;
	if (document.getElementById('CountrySelectAll').checked) count -= 1;

	// Logic for setting and unsetting select all box
	if (count == 0) {
		document.getElementById('CountrySelectAll').checked = false;
		document.getElementById("CountryMultiselectLabel").textContent = "0 SELECTED!";
	}
	else if (count == total) {
		document.getElementById('CountrySelectAll').checked = true;
		document.getElementById("CountryMultiselectLabel").textContent = "All Selected";
	}
	else {
		document.getElementById('CountrySelectAll').checked = false;
		document.getElementById("CountryMultiselectLabel").textContent = count + ' selected';
	}

	// Make list of all available launch sites
	let LaunchSites = new Set();
	Selected.forEach((cb) => {
		if (cb.value == 'All') return;
		CountryToSites.get(cb.value).forEach(Site => LaunchSites.add(Site));
	});
	LaunchSites = [...LaunchSites].sort();

	// Populate launch site options
	const SiteOptions = document.getElementById('SiteOptions');
	SiteOptions.innerHTML = '';

	const SelectAll = document.createElement('label');
	SelectAll.className = 'MultiselectItem';
	SelectAll.innerHTML = `
	<input type="checkbox" value="All" id="SiteSelectAll" checked onclick="SiteSelectAll()">
	<span>Select All</span>
	`;
	SiteOptions.append(SelectAll);
	
	for (const Site of LaunchSites) {
		const label = document.createElement('label');
		label.className = 'MultiselectItem';
		label.innerHTML = `
            <input type="checkbox" value="${Site}" checked onchange="UpdateSiteSelection()">
            <span>${Sites[Site] || Site}</span>
			`;
		SiteOptions.append(label);
	}
	UpdateSiteSelection();
}

window.UpdateSiteSelection = function() {
	// Get count of selected and total options
	const total = document.querySelectorAll('#SiteOptions input[type="checkbox"]').length - 1;
	let count = document.querySelectorAll('#SiteOptions input[type="checkbox"]:checked').length;
	if (document.getElementById('SiteSelectAll').checked) count -= 1;

	// Logic for setting and unsetting select all box
	if (count == 0) {
		document.getElementById('SiteSelectAll').checked = false;
		document.getElementById("SiteMultiselectLabel").textContent = "0 SELECTED!";
	}
	else if (count == total) {
		document.getElementById('SiteSelectAll').checked = true;
		document.getElementById("SiteMultiselectLabel").textContent = "All Selected";
	}
	else {
		document.getElementById('SiteSelectAll').checked = false;
		document.getElementById("SiteMultiselectLabel").textContent = count + ' selected';
	}
}

window.CountrySelectAll = function(){
	const CountryOptions = document.getElementById('CountryOptions');
	const Checkboxes = CountryOptions.querySelectorAll('input[type="checkbox"]');
	const ToCheck = document.getElementById('CountrySelectAll').checked;
	Checkboxes.forEach(cb => { cb.checked = ToCheck; });
	UpdateCountrySelection();
}

window.SiteSelectAll = function(){
	const SiteOptions = document.getElementById('SiteOptions');
	const Checkboxes = SiteOptions.querySelectorAll('input[type="checkbox"]');
	const ToCheck = document.getElementById('SiteSelectAll').checked;
	Checkboxes.forEach(cb => { cb.checked = ToCheck; });
	UpdateSiteSelection();
}

// Close dropdowns on outside click
document.addEventListener('click', function(e) {
	const Country = document.getElementById('CountrySelectContainer');
	const Site = document.getElementById('SiteSelectContainer');
    if (!Country.contains(e.target))
        document.getElementById('CountryOptions').classList.remove('open');
    if (!Site.contains(e.target))
        document.getElementById('SiteOptions').classList.remove('open');
});

// Track or untrack sat on viewport click
handler.setInputAction(function (event) {
	const ClickedObjects = viewer.scene.drillPick(
		event.position,
		3,
		ClickAOE,
		ClickAOE
	);

	for (const sat of ClickedObjects) {
		if (sat.primitive && sat.primitive.id && sat.primitive.id != "HoverHighlight" && sat.primitive.show) {
			SatClicked(sat.primitive.id);
			return;
		}
	}
	ResetTrack();
}, ScreenSpaceEventType.LEFT_CLICK);

// Show highlight
handler.setInputAction(function (movement) { MousePosition = movement.endPosition; }, ScreenSpaceEventType.MOUSE_MOVE);

window.ToggleSidebar = function(ID){
	const Sidebar = document.getElementById(ID);
	Sidebar.classList.toggle("open");
}

window.ToggleMultiselect = function(ID){
	document.getElementById(ID).classList.toggle('open');
}

window.PageTurn = function(Next) {
	if (Next && PageIndex < Math.trunc(ActiveIds.length / PageLength))
		PageIndex += 1;
	else if (!Next && PageIndex > 0)
		PageIndex -=1;
	RenderPage();
}

window.OpenRepo = function() {
	window.open('https://github.com/abhijato-c/Azimuthal', '_blank').focus();
}

Init();