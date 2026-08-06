const TestUrl = "https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/limit/1/format/json";
const LoginUrl = "https://www.space-track.org/ajaxauth/login";

export async function GetCookie(){
    // Do login
    console.log('Logging in to Space-Track');
    const resp = await fetch(LoginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `identity=${encodeURIComponent(process.env.SPACETRACK_EMAIL)}&password=${encodeURIComponent(process.env.SPACETRACK_PASSWORD)}`
    });
    if (!resp.ok)
        throw new Error('Login failed:' + resp.statusText);

    const RawCookie = resp.headers.get('set-cookie');
    console.log('Received cookie:', RawCookie);

    return RawCookie.split(';')[0];
}