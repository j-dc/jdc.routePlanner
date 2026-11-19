function routeCost(route, matrix) {
  let total = 0;
  let previous = 0;
  for (const index of route) {
    total += matrix[previous][index];
    previous = index;
  }
  return total + matrix[previous][0];
}

function range(values) {
  return Math.max(...values) - Math.min(...values);
}

function spread(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
}

function visit(previous, next, locationIds) {
  return next !== 0 && (previous === 0 || locationIds[previous] !== locationIds[next]) ? 1 : 0;
}

export function serviceTime(route, locationIds, serviceSecondsPerVisit) {
  let visits = 0;
  let previous = 0;
  for (const index of route) {
    visits += visit(previous, index, locationIds);
    previous = index;
  }
  return visits * serviceSecondsPerVisit;
}

export function splitTrips(route) {
  const trips = [[]];
  for (const index of route) {
    if (index === 0) trips.push([]);
    else trips[trips.length - 1].push(index);
  }
  return trips;
}

export function createOldGroups(routeLabels, locations) {
  if (!routeLabels.some(label => label.length > 0)) return null;
  const groups = new Map(), unassignedRecords = [];
  const indices = routeLabels.map((_, index) => index + 1)
    .sort((a, b) => locations[a].csvRecordNumber - locations[b].csvRecordNumber);
  for (const index of indices) {
    const label = routeLabels[index - 1];
    if (!label) {
      unassignedRecords.push(locations[index].csvRecordNumber);
      continue;
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(index);
  }
  return { groups, unassignedRecords };
}

function tripInfo(route, packageCounts) {
  const segments = [], loads = [0], sizes = [0];
  let segment = 0;
  for (const index of route) {
    segments.push(segment);
    if (index === 0) {
      segment++;
      loads.push(0);
      sizes.push(0);
    } else {
      loads[segment] += packageCounts[index];
      sizes[segment]++;
    }
  }
  return { segments, loads, sizes };
}

export function balanceRoutes(initial, durations, distances, locationIds, serviceSecondsPerVisit,
  packageCounts, capacity, reloadSeconds, maxDifferenceSeconds) {
  const routes = initial.map(route => [...route]);
  const times = routes.map(route => routeCost(route, durations) + serviceTime(route, locationIds, serviceSecondsPerVisit) +
    (splitTrips(route).length - 1) * reloadSeconds);
  const lengths = routes.map(route => routeCost(route, distances));
  let totalDistance = lengths.reduce((sum, length) => sum + length, 0);

  for (let iteration = 0; iteration < 2000; iteration++) {
    const info = routes.map(route => tripInfo(route, packageCounts));
    let bestRange = range(times);
    let bestSpread = spread(times);
    let bestDistance = totalDistance;
    let best = null;
    function consider(first, second, firstTime, secondTime, distance, operation) {
      const candidateTimes = times.map((value, index) =>
        index === first ? firstTime : index === second ? secondTime : value);
      const candidateRange = range(candidateTimes);
      const candidateSpread = spread(candidateTimes);
      const better = bestRange > maxDifferenceSeconds
        ? candidateRange < bestRange ||
          (candidateRange === bestRange && (candidateSpread < bestSpread ||
            (candidateSpread === bestSpread && distance < bestDistance)))
        : candidateRange <= maxDifferenceSeconds &&
          (distance < bestDistance || (distance === bestDistance &&
            (candidateRange < bestRange || (candidateRange === bestRange && candidateSpread < bestSpread))));
      if (better) {
        bestRange = candidateRange;
        bestSpread = candidateSpread;
        bestDistance = distance;
        best = { first, second, firstTime, secondTime, operation };
      }
    }

    for (let first = 0; first < routes.length; first++) {
      const a = routes[first];
      for (let i = 0; i < a.length - 1; i++) {
        if (a[i] === 0) continue;
        const previous = i === 0 ? 0 : a[i - 1], start = a[i];
        let reversedTime = 0, reversedDistance = 0;
        for (let j = i + 1; j < a.length; j++) {
          const end = a[j], next = j + 1 === a.length ? 0 : a[j + 1];
          if (end === 0) break;
          reversedTime += durations[end][a[j - 1]] - durations[a[j - 1]][end];
          reversedDistance += distances[end][a[j - 1]] - distances[a[j - 1]][end];
          const time = times[first] + reversedTime +
            durations[previous][end] + durations[start][next] - durations[previous][start] - durations[end][next] +
            serviceSecondsPerVisit * (visit(previous, end, locationIds) + visit(start, next, locationIds) -
              visit(previous, start, locationIds) - visit(end, next, locationIds));
          const distance = totalDistance + reversedDistance +
            distances[previous][end] + distances[start][next] - distances[previous][start] - distances[end][next];
          consider(first, -1, time, 0, distance, { type: 'reverse', i, j });
        }
      }
      for (let second = 0; second < routes.length; second++) {
        if (first === second) continue;
        const b = routes[second];
        const trips = splitTrips(a);
        if (trips.length > 1) {
          for (let tripIndex = 0; tripIndex < trips.length; tripIndex++) {
            const trip = trips[tripIndex];
            const tripTime = routeCost(trip, durations) + serviceTime(trip, locationIds, serviceSecondsPerVisit) + reloadSeconds;
            consider(first, second, times[first] - tripTime, times[second] + tripTime,
              totalDistance, { type: 'trip', tripIndex });
          }
        }
        for (let i = 0; i < a.length; i++) {
          const item = a[i], previous = i === 0 ? 0 : a[i - 1], next = i + 1 === a.length ? 0 : a[i + 1];
          if (item === 0) continue;
          const firstSegment = info[first].segments[i];
          const removeTrip = info[first].sizes[firstSegment] === 1;
          if (!removeTrip || info[first].loads.length > 1) {
            const removedTime = removeTrip
              ? -durations[0][item] - durations[item][0] - serviceSecondsPerVisit - reloadSeconds
              : durations[previous][next] - durations[previous][item] - durations[item][next] +
                serviceSecondsPerVisit * (visit(previous, next, locationIds) - visit(previous, item, locationIds) - visit(item, next, locationIds));
            const removedDistance = removeTrip
              ? -distances[0][item] - distances[item][0]
              : distances[previous][next] - distances[previous][item] - distances[item][next];
            for (let j = 0; j <= b.length; j++) {
              const targetSegment = j === b.length ? info[second].loads.length - 1 : info[second].segments[j];
              if (info[second].loads[targetSegment] + packageCounts[item] > capacity) continue;
              const before = j === 0 ? 0 : b[j - 1], after = j === b.length ? 0 : b[j];
              const insertedTime = durations[before][item] + durations[item][after] - durations[before][after] +
                serviceSecondsPerVisit * (visit(before, item, locationIds) + visit(item, after, locationIds) - visit(before, after, locationIds));
              const insertedDistance = distances[before][item] + distances[item][after] - distances[before][after];
              consider(first, second, times[first] + removedTime, times[second] + insertedTime,
                totalDistance + removedDistance + insertedDistance, { type: 'move', i, j, removeTrip });
            }
          }
          if (second < first) continue;
          for (let j = 0; j < b.length; j++) {
            const other = b[j], before = j === 0 ? 0 : b[j - 1], after = j + 1 === b.length ? 0 : b[j + 1];
            if (other === 0) continue;
            const secondSegment = info[second].segments[j];
            if (info[first].loads[firstSegment] - packageCounts[item] + packageCounts[other] > capacity ||
                info[second].loads[secondSegment] - packageCounts[other] + packageCounts[item] > capacity) continue;
            const firstTime = times[first] + durations[previous][other] + durations[other][next] - durations[previous][item] - durations[item][next] +
              serviceSecondsPerVisit * (visit(previous, other, locationIds) + visit(other, next, locationIds) - visit(previous, item, locationIds) - visit(item, next, locationIds));
            const secondTime = times[second] + durations[before][item] + durations[item][after] - durations[before][other] - durations[other][after] +
              serviceSecondsPerVisit * (visit(before, item, locationIds) + visit(item, after, locationIds) - visit(before, other, locationIds) - visit(other, after, locationIds));
            const distance = totalDistance + distances[previous][other] + distances[other][next] - distances[previous][item] - distances[item][next] +
              distances[before][item] + distances[item][after] - distances[before][other] - distances[other][after];
            consider(first, second, firstTime, secondTime, distance, { type: 'swap', i, j });
          }
        }
      }
    }
    if (!best) break;
    const { first, second, firstTime, secondTime, operation } = best;
    if (operation.type === 'move') {
      const [item] = routes[first].splice(operation.i, 1);
      if (operation.removeTrip) {
        const separator = routes[first][operation.i] === 0 ? operation.i : operation.i - 1;
        routes[first].splice(separator, 1);
      }
      routes[second].splice(operation.j, 0, item);
    } else if (operation.type === 'swap') {
      [routes[first][operation.i], routes[second][operation.j]] = [routes[second][operation.j], routes[first][operation.i]];
    } else if (operation.type === 'trip') {
      const trips = splitTrips(routes[first]);
      const [trip] = trips.splice(operation.tripIndex, 1);
      routes[first] = trips.flatMap((items, index) => index ? [0, ...items] : items);
      routes[second].push(0, ...trip);
    } else {
      routes[first].splice(operation.i, operation.j - operation.i + 1,
        ...routes[first].slice(operation.i, operation.j + 1).reverse());
    }
    times[first] = firstTime;
    if (second !== -1) times[second] = secondTime;
    totalDistance = bestDistance;
  }
  return { routes, durations: times, distances: routes.map(route => routeCost(route, distances)) };
}

export function completeRoutes(routes, count, durations, locationIds, serviceSecondsPerVisit) {
  while (routes.length < count) {
    let best;
    for (let i = 0; i < routes.length; i++) {
      if (routes[i].length < 2) continue;
      for (let j = 0; j < routes[i].length; j++) {
        const candidate = routes.map(route => [...route]);
        const [item] = candidate[i].splice(j, 1);
        candidate.push([item]);
        const spread = range(candidate.map(route => routeCost(route, durations) + serviceTime(route, locationIds, serviceSecondsPerVisit)));
        if (!best || spread < best.spread) best = { candidate, spread };
      }
    }
    if (!best) throw new Error('Onvoldoende leveringen voor het aantal chauffeurs.');
    routes = best.candidate;
  }
  return routes;
}

export { routeCost };
