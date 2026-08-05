import json

with open('data/CountriesDB.json', 'r') as f:
    CountriesDB = json.load(f)

with open('data/Countries.json', 'r') as f:
    countries = json.load(f)

print("Countries in db but not in Countries.json:")
for country in CountriesDB:
    if country['country'] not in countries.keys():
        print(country['country'])

print("\nCountries in Countries.json but not in db:")
for country in countries.keys():
    if country not in [c['country'] for c in CountriesDB]:
        print(country)

with open('data/SitesDB.json', 'r') as f:
    SitesDB = json.load(f)

with open('data/Sites.json', 'r') as f:
    sites = json.load(f)

print("\nSites in db but not in Sites.json:")
for site in SitesDB:
    if site['launch_site'] not in sites.keys():
        print(site['launch_site'])

print("\nSites in Sites.json but not in db:")
for site in sites.keys():
    if site not in [s['launch_site'] for s in SitesDB]:
        print(site)