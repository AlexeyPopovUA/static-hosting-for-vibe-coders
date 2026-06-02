function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var uri = request.uri;
  var mainBranchName = 'MAIN_BRANCH_NAME_PLACEHOLDER';

  var FILE_REGEX = /\.(html?|css|js|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)(\?.*)?$/i;
  var SAFE_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

  function isValidLabel(name) {
    if (!name || name.indexOf('--') !== -1) {
      return false;
    }
    return SAFE_LABEL_REGEX.test(name);
  }

  var app;
  var branch;
  var devMarker = '.dev.';
  var devIndex = host.indexOf(devMarker);

  if (devIndex !== -1) {
    var hostPrefix = host.substring(0, devIndex);
    var firstLabel = hostPrefix.split('.')[0];
    var parts = firstLabel.split('--');
    app = parts[0];
    branch = parts.slice(1).join('--');
  } else {
    app = host.split('.')[0];
    branch = mainBranchName;
  }

  if (!isValidLabel(app) || !isValidLabel(branch)) {
    return {
      statusCode: 400,
      statusDescription: 'Bad Request',
      headers: {
        'content-type': { value: 'text/plain; charset=utf-8' },
      },
      body: 'Invalid subdomain',
    };
  }

  var path = uri;
  if (!FILE_REGEX.test(path)) {
    if (path.charAt(path.length - 1) !== '/') {
      path = path + '/';
    }
    path = path + 'index.html';
  }

  request.uri = '/' + app + '/' + branch + path;
  return request;
}
