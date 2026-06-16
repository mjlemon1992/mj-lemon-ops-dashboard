cd ~/mjdeploy || { echo "run on the Mac; ~/mjdeploy missing"; exit 1; }
sed -i '' 's#v3/technician?limit=100#v3/user?limit=200#g' server/routes/technicians.js server/routes/shopmonkeySync.js
sed -i '' 's#t.archived !== true#t.assignedTechnician === true \&\& t.active !== false#' server/routes/technicians.js
echo "=== verify (expect /v3/user lines + an assignedTechnician line) ==="
grep -n "v3/user" server/routes/technicians.js server/routes/shopmonkeySync.js
grep -n "assignedTechnician" server/routes/technicians.js
git rm -f deploy.sh 2>/dev/null
git add server/routes/technicians.js server/routes/shopmonkeySync.js
git commit -m "Fix tech roster: pull from /v3/user where assignedTechnician=true (/v3/technician 404s on this account)"
git push origin main
echo "Done. Railway will rebuild in ~2-3 min."bash fix.sh
