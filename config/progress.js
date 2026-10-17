// Numbers for the progress ring (green = submitted, red = overdue, grey = open).
// The ring is drawn with each part's share out of 100, so they fit one circle.
function ringData(done, overdue, total) {
  const open = total - done - overdue;
  const share = (n) => (total ? (n / total) * 100 : 0);
  return {
    total,
    done,
    overdue,
    open,
    percent: total ? Math.round(share(done)) : null,
    doneArc: share(done),
    overdueArc: share(overdue),
    openArc: share(open),
  };
}

module.exports = { ringData };
