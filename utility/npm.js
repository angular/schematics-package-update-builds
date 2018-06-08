"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
const core_1 = require("@angular-devkit/core");
const schematics_1 = require("@angular-devkit/schematics");
const tasks_1 = require("@angular-devkit/schematics/tasks");
const https = require("https");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
const semver = require("semver");
const semverIntersect = require('semver-intersect');
const kPackageJsonDependencyFields = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];
const npmPackageJsonCache = new Map();
function _getVersionFromNpmPackage(json, version, loose) {
    const distTags = json['dist-tags'];
    if (distTags && distTags[version]) {
        return (loose ? '~' : '') + distTags[version];
    }
    else {
        if (!semver.validRange(version)) {
            throw new schematics_1.SchematicsException(`Invalid range or version: "${version}".`);
        }
        if (semver.valid(version) && loose) {
            version = '~' + version;
        }
        const packageVersions = Object.keys(json['versions']);
        const maybeMatch = semver.maxSatisfying(packageVersions, version);
        if (!maybeMatch) {
            throw new schematics_1.SchematicsException(`Version "${version}" has no satisfying version for package ${json['name']}`);
        }
        const maybeOperator = version.match(/^[~^]/);
        if (version == '*') {
            return maybeMatch;
        }
        else if (maybeOperator) {
            return maybeOperator[0] + maybeMatch;
        }
        else {
            return (loose ? '~' : '') + maybeMatch;
        }
    }
}
/**
 * Get the NPM repository's package.json for a package. This is p
 * @param {string} packageName The package name to fetch.
 * @param {LoggerApi} logger A logger instance to log debug information.
 * @returns {Observable<JsonObject>} An observable that will put the pacakge.json content.
 * @private
 */
function _getNpmPackageJson(packageName, logger) {
    const url = `https://registry.npmjs.org/${packageName.replace(/\//g, '%2F')}`;
    logger.debug(`Getting package.json from ${JSON.stringify(packageName)}...`);
    let maybeRequest = npmPackageJsonCache.get(url);
    if (!maybeRequest) {
        const subject = new rxjs_1.ReplaySubject(1);
        const request = https.request(url, response => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const json = core_1.parseJson(data, core_1.JsonParseMode.Strict);
                    subject.next(json);
                    subject.complete();
                }
                catch (err) {
                    subject.error(err);
                }
            });
            response.on('error', err => subject.error(err));
        });
        request.end();
        maybeRequest = subject.asObservable();
        npmPackageJsonCache.set(url, maybeRequest);
    }
    return maybeRequest;
}
/**
 * Recursively get versions of packages to update to, along with peer dependencies. Only recurse
 * peer dependencies and only update versions of packages that are in the original package.json.
 * @param {JsonObject} packageJson The original package.json to update.
 * @param {{[p: string]: string}} packages
 * @param {{[p: string]: string}} allVersions
 * @param {LoggerApi} logger
 * @param {boolean} loose
 * @returns {Observable<void>}
 * @private
 */
function _getRecursiveVersions(packageJson, packages, allVersions, logger, loose) {
    return rxjs_1.from(kPackageJsonDependencyFields).pipe(operators_1.mergeMap(field => {
        const deps = packageJson[field];
        if (deps) {
            return rxjs_1.from(Object.keys(deps)
                .map(depName => depName in deps ? [depName, deps[depName]] : null)
                .filter(x => !!x));
        }
        else {
            return rxjs_1.EMPTY;
        }
    }), operators_1.mergeMap(([depName, depVersion]) => {
        if (!packages[depName] || packages[depName] === depVersion) {
            return rxjs_1.EMPTY;
        }
        if (allVersions[depName] && semver.intersects(allVersions[depName], depVersion)) {
            allVersions[depName] = semverIntersect.intersect(allVersions[depName], depVersion);
            return rxjs_1.EMPTY;
        }
        return _getNpmPackageJson(depName, logger).pipe(operators_1.map(json => ({ version: packages[depName], depName, depVersion, npmPackageJson: json })));
    }), operators_1.mergeMap(({ version, depName, depVersion, npmPackageJson }) => {
        const updateVersion = _getVersionFromNpmPackage(npmPackageJson, version, loose);
        const npmPackageVersions = Object.keys(npmPackageJson['versions']);
        const match = semver.maxSatisfying(npmPackageVersions, updateVersion);
        if (!match) {
            return rxjs_1.EMPTY;
        }
        if (semver.lt(semverIntersect.parseRange(updateVersion).version, semverIntersect.parseRange(depVersion).version)) {
            throw new schematics_1.SchematicsException(`Cannot downgrade package ${JSON.stringify(depName)} from version "${depVersion}" to "${updateVersion}".`);
        }
        const innerNpmPackageJson = npmPackageJson['versions'][match];
        const dependencies = {};
        const deps = innerNpmPackageJson['peerDependencies'];
        if (deps) {
            for (const depName of Object.keys(deps)) {
                dependencies[depName] = deps[depName];
            }
        }
        logger.debug(`Recording update for ${JSON.stringify(depName)} to version ${updateVersion}.`);
        if (allVersions[depName]) {
            if (!semver.intersects(allVersions[depName], updateVersion)) {
                throw new schematics_1.SchematicsException('Cannot update safely because packages have conflicting dependencies. Package '
                    + `${depName} would need to match both versions "${updateVersion}" and `
                    + `"${allVersions[depName]}, which are not compatible.`);
            }
            allVersions[depName] = semverIntersect.intersect(allVersions[depName], updateVersion);
        }
        else {
            allVersions[depName] = updateVersion;
        }
        return _getRecursiveVersions(packageJson, dependencies, allVersions, logger, loose);
    }));
}
/**
 * Use a Rule which can return an observable, but do not actually modify the Tree.
 * This rules perform an HTTPS request to get the npm registry package.json, then resolve the
 * version from the options, and replace the version in the options by an actual version.
 * @param supportedPackages A list of packages to update (at the same version).
 * @param maybeVersion A version to update those packages to.
 * @param loose Whether to use loose version operators (instead of specific versions).
 * @private
 */
function updatePackageJson(supportedPackages, maybeVersion = 'latest', loose = false) {
    const version = maybeVersion ? maybeVersion : 'latest';
    // This will be updated as we read the NPM repository.
    const allVersions = {};
    return schematics_1.chain([
        (tree, context) => {
            const packageJsonContent = tree.read('/package.json');
            if (!packageJsonContent) {
                throw new schematics_1.SchematicsException('Could not find package.json.');
            }
            const packageJson = core_1.parseJson(packageJsonContent.toString(), core_1.JsonParseMode.Strict);
            if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
                throw new schematics_1.SchematicsException('Could not parse package.json.');
            }
            const packages = {};
            for (const name of supportedPackages) {
                packages[name] = version;
            }
            return rxjs_1.concat(_getRecursiveVersions(packageJson, packages, allVersions, context.logger, loose).pipe(operators_1.ignoreElements()), rxjs_1.of(tree));
        },
        (tree) => {
            const packageJsonContent = tree.read('/package.json');
            if (!packageJsonContent) {
                throw new schematics_1.SchematicsException('Could not find package.json.');
            }
            const packageJson = core_1.parseJson(packageJsonContent.toString(), core_1.JsonParseMode.Strict);
            if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
                throw new schematics_1.SchematicsException('Could not parse package.json.');
            }
            for (const field of kPackageJsonDependencyFields) {
                const deps = packageJson[field];
                if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
                    continue;
                }
                for (const depName of Object.keys(deps)) {
                    if (allVersions[depName]) {
                        deps[depName] = allVersions[depName];
                    }
                }
            }
            tree.overwrite('/package.json', JSON.stringify(packageJson, null, 2) + '\n');
            return tree;
        },
        (_tree, context) => {
            context.addTask(new tasks_1.NodePackageInstallTask());
        },
    ]);
}
exports.updatePackageJson = updatePackageJson;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibnBtLmpzIiwic291cmNlUm9vdCI6Ii4vIiwic291cmNlcyI6WyJwYWNrYWdlcy9zY2hlbWF0aWNzL3BhY2thZ2VfdXBkYXRlL3V0aWxpdHkvbnBtLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBQUE7Ozs7OztHQU1HO0FBQ0gsK0NBQXFGO0FBQ3JGLDJEQU1vQztBQUNwQyw0REFBMEU7QUFDMUUsK0JBQStCO0FBQy9CLCtCQU9jO0FBQ2QsOENBQStEO0FBQy9ELGlDQUFpQztBQUVqQyxNQUFNLGVBQWUsR0FBRyxPQUFPLENBQUMsa0JBQWtCLENBQUMsQ0FBQztBQUVwRCxNQUFNLDRCQUE0QixHQUFHO0lBQ25DLGNBQWM7SUFDZCxpQkFBaUI7SUFDakIsa0JBQWtCO0lBQ2xCLHNCQUFzQjtDQUN2QixDQUFDO0FBR0YsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsRUFBa0MsQ0FBQztBQUV0RSxtQ0FBbUMsSUFBZ0IsRUFBRSxPQUFlLEVBQUUsS0FBYztJQUNsRixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFlLENBQUM7SUFDakQsRUFBRSxDQUFDLENBQUMsUUFBUSxJQUFJLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxHQUFHLFFBQVEsQ0FBQyxPQUFPLENBQVcsQ0FBQztJQUMxRCxDQUFDO0lBQUMsSUFBSSxDQUFDLENBQUM7UUFDTixFQUFFLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ2hDLE1BQU0sSUFBSSxnQ0FBbUIsQ0FBQyw4QkFBOEIsT0FBTyxJQUFJLENBQUMsQ0FBQztRQUMzRSxDQUFDO1FBQ0QsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxLQUFLLENBQUMsQ0FB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LElBQUksS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7b0JBQzdELFFBQVEsQ0FBQztnQkFDWCxDQUFDO2dCQUVELEdBQUcsQ0FBQyxDQUFDLE1BQU0sT0FBTyxJQUFJLE1BQU0sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO29CQUN4QyxFQUFFLENBQUMsQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDO3dCQUN6QixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO29CQUN2QyxDQUFDO2dCQUNILENBQUM7WUFDSCxDQUFDO1lBRUQsSUFBSSxDQUFDLFNBQVMsQ0FBQyxlQUFlLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxXQUFXLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO1lBRTdFLE1BQU0sQ0FBQyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBQ0QsQ0FBQyxLQUFXLEVBQUUsT0FBeUIsRUFBRSxFQUFFO1lBQ3pDLE9BQU8sQ0FBQyxPQUFPLENBQUMsSUFBSSw4QkFBc0IsRUFBRSxDQUFDLENBQUM7UUFDaEQsQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUM7QUE5REQsOENBOERDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbGljZW5zZVxuICogQ29weXJpZ2h0IEdvb2dsZSBJbmMuIEFsbCBSaWdodHMgUmVzZXJ2ZWQuXG4gKlxuICogVXNlIG9mIHRoaXMgc291cmNlIGNvZGUgaXMgZ292ZXJuZWQgYnkgYW4gTUlULXN0eWxlIGxpY2Vuc2UgdGhhdCBjYW4gYmVcbiAqIGZvdW5kIGluIHRoZSBMSUNFTlNFIGZpbGUgYXQgaHR0cHM6Ly9hbmd1bGFyLmlvL2xpY2Vuc2VcbiAqL1xuaW1wb3J0IHsgSnNvbk9iamVjdCwgSnNvblBhcnNlTW9kZSwgbG9nZ2luZywgcGFyc2VKc29uIH0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHtcbiAgUnVsZSxcbiAgU2NoZW1hdGljQ29udGV4dCxcbiAgU2NoZW1hdGljc0V4Y2VwdGlvbixcbiAgVHJlZSxcbiAgY2hhaW4sXG59IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9zY2hlbWF0aWNzJztcbmltcG9ydCB7IE5vZGVQYWNrYWdlSW5zdGFsbFRhc2sgfSBmcm9tICdAYW5ndWxhci1kZXZraXQvc2NoZW1hdGljcy90YXNrcyc7XG5pbXBvcnQgKiBhcyBodHRwcyBmcm9tICdodHRwcyc7XG5pbXBvcnQge1xuICBFTVBUWSxcbiAgT2JzZXJ2YWJsZSxcbiAgUmVwbGF5U3ViamVjdCxcbiAgY29uY2F0LFxuICBmcm9tIGFzIG9ic2VydmFibGVGcm9tLFxuICBvZiBhcyBvYnNlcnZhYmxlT2YsXG59IGZyb20gJ3J4anMnO1xuaW1wb3J0IHsgaWdub3JlRWxlbWVudHMsIG1hcCwgbWVyZ2VNYXAgfSBmcm9tICdyeGpzL29wZXJhdG9ycyc7XG5pbXBvcnQgKiBhcyBzZW12ZXIgZnJvbSAnc2VtdmVyJztcblxuY29uc3Qgc2VtdmVySW50ZXJzZWN0ID0gcmVxdWlyZSgnc2VtdmVyLWludGVyc2VjdCcpO1xuXG5jb25zdCBrUGFja2FnZUpzb25EZXBlbmRlbmN5RmllbGRzID0gW1xuICAnZGVwZW5kZW5jaWVzJyxcbiAgJ2RldkRlcGVuZGVuY2llcycsXG4gICdwZWVyRGVwZW5kZW5jaWVzJyxcbiAgJ29wdGlvbmFsRGVwZW5kZW5jaWVzJyxcbl07XG5cblxuY29uc3QgbnBtUGFja2FnZUpzb25DYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBPYnNlcnZhYmxlPEpzb25PYmplY3Q+PigpO1xuXG5mdW5jdGlvbiBfZ2V0VmVyc2lvbkZyb21OcG1QYWNrYWdlKGpzb246IEpzb25PYmplY3QsIHZlcnNpb246IHN0cmluZywgbG9vc2U6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBkaXN0VGFncyA9IGpzb25bJ2Rpc3QtdGFncyddIGFzIEpzb25PYmplY3Q7XG4gIGlmIChkaXN0VGFncyAmJiBkaXN0VGFnc1t2ZXJzaW9uXSkge1xuICAgIHJldHVybiAobG9vc2UgPyAnficgOiAnJykgKyBkaXN0VGFnc1t2ZXJzaW9uXSBhcyBzdHJpbmc7XG4gIH0gZWxzZSB7XG4gICAgaWYgKCFzZW12ZXIudmFsaWRSYW5nZSh2ZXJzaW9uKSkge1xuICAgICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oYEludmFsaWQgcmFuZ2Ugb3IgdmVyc2lvbjogXCIke3ZlcnNpb259XCIuYCk7XG4gICAgfVxuICAgIGlmIChzZW12ZXIudmFsaWQodmVyc2lvbikgJiYgbG9vc2UpIHtcbiAgICAgIHZlcnNpb24gPSAnficgKyB2ZXJzaW9uO1xuICAgIH1cblxuICAgIGNvbnN0IHBhY2thZ2VWZXJzaW9ucyA9IE9iamVjdC5rZXlzKGpzb25bJ3ZlcnNpb25zJ10gYXMgSnNvbk9iamVjdCk7XG4gICAgY29uc3QgbWF5YmVNYXRjaCA9IHNlbXZlci5tYXhTYXRpc2Z5aW5nKHBhY2thZ2VWZXJzaW9ucywgdmVyc2lvbik7XG5cbiAgICBpZiAoIW1heWJlTWF0Y2gpIHtcbiAgICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKFxuICAgICAgICBgVmVyc2lvbiBcIiR7dmVyc2lvbn1cIiBoYXMgbm8gc2F0aXNmeWluZyB2ZXJzaW9uIGZvciBwYWNrYWdlICR7anNvblsnbmFtZSddfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IG1heWJlT3BlcmF0b3IgPSB2ZXJzaW9uLm1hdGNoKC9eW35eXS8pO1xuICAgIGlmICh2ZXJzaW9uID09ICcqJykge1xuICAgICAgcmV0dXJuIG1heWJlTWF0Y2g7XG4gICAgfSBlbHNlIGlmIChtYXliZU9wZXJhdG9yKSB7XG4gICAgICByZXR1cm4gbWF5YmVPcGVyYXRvclswXSArIG1heWJlTWF0Y2g7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiAobG9vc2UgPyAnficgOiAnJykgKyBtYXliZU1hdGNoO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgTlBNIHJlcG9zaXRvcnkncyBwYWNrYWdlLmpzb24gZm9yIGEgcGFja2FnZS4gVGhpcyBpcyBwXG4gKiBAcGFyYW0ge3N0cmluZ30gcGFja2FnZU5hbWUgVGhlIHBhY2thZ2UgbmFtZSB0byBmZXRjaC5cbiAqIEBwYXJhbSB7TG9nZ2VyQXBpfSBsb2dnZXIgQSBsb2dnZXIgaW5zdGFuY2UgdG8gbG9nIGRlYnVnIGluZm9ybWF0aW9uLlxuICogQHJldHVybnMge09ic2VydmFibGU8SnNvbk9iamVjdD59IEFuIG9ic2VydmFibGUgdGhhdCB3aWxsIHB1dCB0aGUgcGFjYWtnZS5qc29uIGNvbnRlbnQuXG4gKiBAcHJpdmF0ZVxuICovXG5mdW5jdGlvbiBfZ2V0TnBtUGFja2FnZUpzb24oXG4gIHBhY2thZ2VOYW1lOiBzdHJpbmcsXG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXJBcGksXG4pOiBPYnNlcnZhYmxlPEpzb25PYmplY3Q+IHtcbiAgY29uc3QgdXJsID0gYGh0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnLyR7cGFja2FnZU5hbWUucmVwbGFjZSgvXFwvL2csICclMkYnKX1gO1xuICBsb2dnZXIuZGVidWcoYEdldHRpbmcgcGFja2FnZS5qc29uIGZyb20gJHtKU09OLnN0cmluZ2lmeShwYWNrYWdlTmFtZSl9Li4uYCk7XG5cbiAgbGV0IG1heWJlUmVxdWVzdCA9IG5wbVBhY2thZ2VKc29uQ2FjaGUuZ2V0KHVybCk7XG4gIGlmICghbWF5YmVSZXF1ZXN0KSB7XG4gICAgY29uc3Qgc3ViamVjdCA9IG5ldyBSZXBsYXlTdWJqZWN0PEpzb25PYmplY3Q+KDEpO1xuXG4gICAgY29uc3QgcmVxdWVzdCA9IGh0dHBzLnJlcXVlc3QodXJsLCByZXNwb25zZSA9PiB7XG4gICAgICBsZXQgZGF0YSA9ICcnO1xuICAgICAgcmVzcG9uc2Uub24oJ2RhdGEnLCBjaHVuayA9PiBkYXRhICs9IGNodW5rKTtcbiAgICAgIHJlc3BvbnNlLm9uKCdlbmQnLCAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QganNvbiA9IHBhcnNlSnNvbihkYXRhLCBKc29uUGFyc2VNb2RlLlN0cmljdCk7XG4gICAgICAgICAgc3ViamVjdC5uZXh0KGpzb24gYXMgSnNvbk9iamVjdCk7XG4gICAgICAgICAgc3ViamVjdC5jb21wbGV0ZSgpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBzdWJqZWN0LmVycm9yKGVycik7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgcmVzcG9uc2Uub24oJ2Vycm9yJywgZXJyID0+IHN1YmplY3QuZXJyb3IoZXJyKSk7XG4gICAgfSk7XG4gICAgcmVxdWVzdC5lbmQoKTtcblxuICAgIG1heWJlUmVxdWVzdCA9IHN1YmplY3QuYXNPYnNlcnZhYmxlKCk7XG4gICAgbnBtUGFja2FnZUpzb25DYWNoZS5zZXQodXJsLCBtYXliZVJlcXVlc3QpO1xuICB9XG5cbiAgcmV0dXJuIG1heWJlUmVxdWVzdDtcbn1cblxuLyoqXG4gKiBSZWN1cnNpdmVseSBnZXQgdmVyc2lvbnMgb2YgcGFja2FnZXMgdG8gdXBkYXRlIHRvLCBhbG9uZyB3aXRoIHBlZXIgZGVwZW5kZW5jaWVzLiBPbmx5IHJlY3Vyc2VcbiAqIHBlZXIgZGVwZW5kZW5jaWVzIGFuZCBvbmx5IHVwZGF0ZSB2ZXJzaW9ucyBvZiBwYWNrYWdlcyB0aGF0IGFyZSBpbiB0aGUgb3JpZ2luYWwgcGFja2FnZS5qc29uLlxuICogQHBhcmFtIHtKc29uT2JqZWN0fSBwYWNrYWdlSnNvbiBUaGUgb3JpZ2luYWwgcGFja2FnZS5qc29uIHRvIHVwZGF0ZS5cbiAqIEBwYXJhbSB7e1twOiBzdHJpbmddOiBzdHJpbmd9fSBwYWNrYWdlc1xuICogQHBhcmFtIHt7W3A6IHN0cmluZ106IHN0cmluZ319IGFsbFZlcnNpb25zXG4gKiBAcGFyYW0ge0xvZ2dlckFwaX0gbG9nZ2VyXG4gKiBAcGFyYW0ge2Jvb2xlYW59IGxvb3NlXG4gKiBAcmV0dXJucyB7T2JzZXJ2YWJsZTx2b2lkPn1cbiAqIEBwcml2YXRlXG4gKi9cbmZ1bmN0aW9uIF9nZXRSZWN1cnNpdmVWZXJzaW9ucyhcbiAgcGFja2FnZUpzb246IEpzb25PYmplY3QsXG4gIHBhY2thZ2VzOiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfSxcbiAgYWxsVmVyc2lvbnM6IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB9LFxuICBsb2dnZXI6IGxvZ2dpbmcuTG9nZ2VyQXBpLFxuICBsb29zZTogYm9vbGVhbixcbik6IE9ic2VydmFibGU8dm9pZD4ge1xuICByZXR1cm4gb2JzZXJ2YWJsZUZyb20oa1BhY2thZ2VKc29uRGVwZW5kZW5jeUZpZWxkcykucGlwZShcbiAgICBtZXJnZU1hcChmaWVsZCA9PiB7XG4gICAgICBjb25zdCBkZXBzID0gcGFja2FnZUpzb25bZmllbGRdIGFzIEpzb25PYmplY3Q7XG4gICAgICBpZiAoZGVwcykge1xuICAgICAgICByZXR1cm4gb2JzZXJ2YWJsZUZyb20oXG4gICAgICAgICAgT2JqZWN0LmtleXMoZGVwcylcbiAgICAgICAgICAgIC5tYXAoZGVwTmFtZSA9PiBkZXBOYW1lIGluIGRlcHMgPyBbZGVwTmFtZSwgZGVwc1tkZXBOYW1lXV0gOiBudWxsKVxuICAgICAgICAgICAgLmZpbHRlcih4ID0+ICEheCksXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gRU1QVFk7XG4gICAgICB9XG4gICAgfSksXG4gICAgbWVyZ2VNYXAoKFtkZXBOYW1lLCBkZXBWZXJzaW9uXTogW3N0cmluZywgc3RyaW5nXSkgPT4ge1xuICAgICAgaWYgKCFwYWNrYWdlc1tkZXBOYW1lXSB8fCBwYWNrYWdlc1tkZXBOYW1lXSA9PT0gZGVwVmVyc2lvbikge1xuICAgICAgICByZXR1cm4gRU1QVFk7XG4gICAgICB9XG4gICAgICBpZiAoYWxsVmVyc2lvbnNbZGVwTmFtZV0gJiYgc2VtdmVyLmludGVyc2VjdHMoYWxsVmVyc2lvbnNbZGVwTmFtZV0sIGRlcFZlcnNpb24pKSB7XG4gICAgICAgIGFsbFZlcnNpb25zW2RlcE5hbWVdID0gc2VtdmVySW50ZXJzZWN0LmludGVyc2VjdChhbGxWZXJzaW9uc1tkZXBOYW1lXSwgZGVwVmVyc2lvbik7XG5cbiAgICAgICAgcmV0dXJuIEVNUFRZO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gX2dldE5wbVBhY2thZ2VKc29uKGRlcE5hbWUsIGxvZ2dlcikucGlwZShcbiAgICAgICAgbWFwKGpzb24gPT4gKHsgdmVyc2lvbjogcGFja2FnZXNbZGVwTmFtZV0sIGRlcE5hbWUsIGRlcFZlcnNpb24sIG5wbVBhY2thZ2VKc29uOiBqc29uIH0pKSxcbiAgICAgICk7XG4gICAgfSksXG4gICAgbWVyZ2VNYXAoKHt2ZXJzaW9uLCBkZXBOYW1lLCBkZXBWZXJzaW9uLCBucG1QYWNrYWdlSnNvbn0pID0+IHtcbiAgICAgIGNvbnN0IHVwZGF0ZVZlcnNpb24gPSBfZ2V0VmVyc2lvbkZyb21OcG1QYWNrYWdlKG5wbVBhY2thZ2VKc29uLCB2ZXJzaW9uLCBsb29zZSk7XG4gICAgICBjb25zdCBucG1QYWNrYWdlVmVyc2lvbnMgPSBPYmplY3Qua2V5cyhucG1QYWNrYWdlSnNvblsndmVyc2lvbnMnXSBhcyBKc29uT2JqZWN0KTtcbiAgICAgIGNvbnN0IG1hdGNoID0gc2VtdmVyLm1heFNhdGlzZnlpbmcobnBtUGFja2FnZVZlcnNpb25zLCB1cGRhdGVWZXJzaW9uKTtcbiAgICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgcmV0dXJuIEVNUFRZO1xuICAgICAgfVxuICAgICAgaWYgKHNlbXZlci5sdChcbiAgICAgICAgc2VtdmVySW50ZXJzZWN0LnBhcnNlUmFuZ2UodXBkYXRlVmVyc2lvbikudmVyc2lvbixcbiAgICAgICAgc2VtdmVySW50ZXJzZWN0LnBhcnNlUmFuZ2UoZGVwVmVyc2lvbikudmVyc2lvbilcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbihgQ2Fubm90IGRvd25ncmFkZSBwYWNrYWdlICR7XG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZGVwTmFtZSl9IGZyb20gdmVyc2lvbiBcIiR7ZGVwVmVyc2lvbn1cIiB0byBcIiR7dXBkYXRlVmVyc2lvbn1cIi5gLFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpbm5lck5wbVBhY2thZ2VKc29uID0gKG5wbVBhY2thZ2VKc29uWyd2ZXJzaW9ucyddIGFzIEpzb25PYmplY3QpW21hdGNoXSBhcyBKc29uT2JqZWN0O1xuICAgICAgY29uc3QgZGVwZW5kZW5jaWVzOiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmcgfSA9IHt9O1xuXG4gICAgICBjb25zdCBkZXBzID0gaW5uZXJOcG1QYWNrYWdlSnNvblsncGVlckRlcGVuZGVuY2llcyddIGFzIEpzb25PYmplY3Q7XG4gICAgICBpZiAoZGVwcykge1xuICAgICAgICBmb3IgKGNvbnN0IGRlcE5hbWUgb2YgT2JqZWN0LmtleXMoZGVwcykpIHtcbiAgICAgICAgICBkZXBlbmRlbmNpZXNbZGVwTmFtZV0gPSBkZXBzW2RlcE5hbWVdIGFzIHN0cmluZztcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBsb2dnZXIuZGVidWcoYFJlY29yZGluZyB1cGRhdGUgZm9yICR7SlNPTi5zdHJpbmdpZnkoZGVwTmFtZSl9IHRvIHZlcnNpb24gJHt1cGRhdGVWZXJzaW9ufS5gKTtcblxuICAgICAgaWYgKGFsbFZlcnNpb25zW2RlcE5hbWVdKSB7XG4gICAgICAgIGlmICghc2VtdmVyLmludGVyc2VjdHMoYWxsVmVyc2lvbnNbZGVwTmFtZV0sIHVwZGF0ZVZlcnNpb24pKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFNjaGVtYXRpY3NFeGNlcHRpb24oXG4gICAgICAgICAgICAnQ2Fubm90IHVwZGF0ZSBzYWZlbHkgYmVjYXVzZSBwYWNrYWdlcyBoYXZlIGNvbmZsaWN0aW5nIGRlcGVuZGVuY2llcy4gUGFja2FnZSAnXG4gICAgICAgICAgICArIGAke2RlcE5hbWV9IHdvdWxkIG5lZWQgdG8gbWF0Y2ggYm90aCB2ZXJzaW9ucyBcIiR7dXBkYXRlVmVyc2lvbn1cIiBhbmQgYFxuICAgICAgICAgICAgKyBgXCIke2FsbFZlcnNpb25zW2RlcE5hbWVdfSwgd2hpY2ggYXJlIG5vdCBjb21wYXRpYmxlLmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFsbFZlcnNpb25zW2RlcE5hbWVdID0gc2VtdmVySW50ZXJzZWN0LmludGVyc2VjdChhbGxWZXJzaW9uc1tkZXBOYW1lXSwgdXBkYXRlVmVyc2lvbik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhbGxWZXJzaW9uc1tkZXBOYW1lXSA9IHVwZGF0ZVZlcnNpb247XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBfZ2V0UmVjdXJzaXZlVmVyc2lvbnMoXG4gICAgICAgIHBhY2thZ2VKc29uLFxuICAgICAgICBkZXBlbmRlbmNpZXMsXG4gICAgICAgIGFsbFZlcnNpb25zLFxuICAgICAgICBsb2dnZXIsXG4gICAgICAgIGxvb3NlLFxuICAgICAgKTtcbiAgICB9KSxcbiAgKTtcbn1cblxuLyoqXG4gKiBVc2UgYSBSdWxlIHdoaWNoIGNhbiByZXR1cm4gYW4gb2JzZXJ2YWJsZSwgYnV0IGRvIG5vdCBhY3R1YWxseSBtb2RpZnkgdGhlIFRyZWUuXG4gKiBUaGlzIHJ1bGVzIHBlcmZvcm0gYW4gSFRUUFMgcmVxdWVzdCB0byBnZXQgdGhlIG5wbSByZWdpc3RyeSBwYWNrYWdlLmpzb24sIHRoZW4gcmVzb2x2ZSB0aGVcbiAqIHZlcnNpb24gZnJvbSB0aGUgb3B0aW9ucywgYW5kIHJlcGxhY2UgdGhlIHZlcnNpb24gaW4gdGhlIG9wdGlvbnMgYnkgYW4gYWN0dWFsIHZlcnNpb24uXG4gKiBAcGFyYW0gc3VwcG9ydGVkUGFja2FnZXMgQSBsaXN0IG9mIHBhY2thZ2VzIHRvIHVwZGF0ZSAoYXQgdGhlIHNhbWUgdmVyc2lvbikuXG4gKiBAcGFyYW0gbWF5YmVWZXJzaW9uIEEgdmVyc2lvbiB0byB1cGRhdGUgdGhvc2UgcGFja2FnZXMgdG8uXG4gKiBAcGFyYW0gbG9vc2UgV2hldGhlciB0byB1c2UgbG9vc2UgdmVyc2lvbiBvcGVyYXRvcnMgKGluc3RlYWQgb2Ygc3BlY2lmaWMgdmVyc2lvbnMpLlxuICogQHByaXZhdGVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBhY2thZ2VKc29uKFxuICBzdXBwb3J0ZWRQYWNrYWdlczogc3RyaW5nW10sXG4gIG1heWJlVmVyc2lvbiA9ICdsYXRlc3QnLFxuICBsb29zZSA9IGZhbHNlLFxuKTogUnVsZSB7XG4gIGNvbnN0IHZlcnNpb24gPSBtYXliZVZlcnNpb24gPyBtYXliZVZlcnNpb24gOiAnbGF0ZXN0JztcbiAgLy8gVGhpcyB3aWxsIGJlIHVwZGF0ZWQgYXMgd2UgcmVhZCB0aGUgTlBNIHJlcG9zaXRvcnkuXG4gIGNvbnN0IGFsbFZlcnNpb25zOiB7IFtuYW1lOiBzdHJpbmddOiBzdHJpbmd9ID0ge307XG5cbiAgcmV0dXJuIGNoYWluKFtcbiAgICAodHJlZTogVHJlZSwgY29udGV4dDogU2NoZW1hdGljQ29udGV4dCk6IE9ic2VydmFibGU8VHJlZT4gPT4ge1xuICAgICAgY29uc3QgcGFja2FnZUpzb25Db250ZW50ID0gdHJlZS5yZWFkKCcvcGFja2FnZS5qc29uJyk7XG4gICAgICBpZiAoIXBhY2thZ2VKc29uQ29udGVudCkge1xuICAgICAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQ291bGQgbm90IGZpbmQgcGFja2FnZS5qc29uLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFja2FnZUpzb24gPSBwYXJzZUpzb24ocGFja2FnZUpzb25Db250ZW50LnRvU3RyaW5nKCksIEpzb25QYXJzZU1vZGUuU3RyaWN0KTtcbiAgICAgIGlmIChwYWNrYWdlSnNvbiA9PT0gbnVsbCB8fCB0eXBlb2YgcGFja2FnZUpzb24gIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGFja2FnZUpzb24pKSB7XG4gICAgICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdDb3VsZCBub3QgcGFyc2UgcGFja2FnZS5qc29uLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFja2FnZXM6IHsgW25hbWU6IHN0cmluZ106IHN0cmluZyB9ID0ge307XG4gICAgICBmb3IgKGNvbnN0IG5hbWUgb2Ygc3VwcG9ydGVkUGFja2FnZXMpIHtcbiAgICAgICAgcGFja2FnZXNbbmFtZV0gPSB2ZXJzaW9uO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gY29uY2F0KFxuICAgICAgICBfZ2V0UmVjdXJzaXZlVmVyc2lvbnMocGFja2FnZUpzb24sIHBhY2thZ2VzLCBhbGxWZXJzaW9ucywgY29udGV4dC5sb2dnZXIsIGxvb3NlKS5waXBlKFxuICAgICAgICAgIGlnbm9yZUVsZW1lbnRzKCksXG4gICAgICAgICksXG4gICAgICAgIG9ic2VydmFibGVPZih0cmVlKSxcbiAgICAgICk7XG4gICAgfSxcbiAgICAodHJlZTogVHJlZSkgPT4ge1xuICAgICAgY29uc3QgcGFja2FnZUpzb25Db250ZW50ID0gdHJlZS5yZWFkKCcvcGFja2FnZS5qc29uJyk7XG4gICAgICBpZiAoIXBhY2thZ2VKc29uQ29udGVudCkge1xuICAgICAgICB0aHJvdyBuZXcgU2NoZW1hdGljc0V4Y2VwdGlvbignQ291bGQgbm90IGZpbmQgcGFja2FnZS5qc29uLicpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFja2FnZUpzb24gPSBwYXJzZUpzb24ocGFja2FnZUpzb25Db250ZW50LnRvU3RyaW5nKCksIEpzb25QYXJzZU1vZGUuU3RyaWN0KTtcbiAgICAgIGlmIChwYWNrYWdlSnNvbiA9PT0gbnVsbCB8fCB0eXBlb2YgcGFja2FnZUpzb24gIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocGFja2FnZUpzb24pKSB7XG4gICAgICAgIHRocm93IG5ldyBTY2hlbWF0aWNzRXhjZXB0aW9uKCdDb3VsZCBub3QgcGFyc2UgcGFja2FnZS5qc29uLicpO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGtQYWNrYWdlSnNvbkRlcGVuZGVuY3lGaWVsZHMpIHtcbiAgICAgICAgY29uc3QgZGVwcyA9IHBhY2thZ2VKc29uW2ZpZWxkXTtcbiAgICAgICAgaWYgKCFkZXBzIHx8IHR5cGVvZiBkZXBzICE9PSAnb2JqZWN0JyB8fCBBcnJheS5pc0FycmF5KGRlcHMpKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGNvbnN0IGRlcE5hbWUgb2YgT2JqZWN0LmtleXMoZGVwcykpIHtcbiAgICAgICAgICBpZiAoYWxsVmVyc2lvbnNbZGVwTmFtZV0pIHtcbiAgICAgICAgICAgIGRlcHNbZGVwTmFtZV0gPSBhbGxWZXJzaW9uc1tkZXBOYW1lXTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdHJlZS5vdmVyd3JpdGUoJy9wYWNrYWdlLmpzb24nLCBKU09OLnN0cmluZ2lmeShwYWNrYWdlSnNvbiwgbnVsbCwgMikgKyAnXFxuJyk7XG5cbiAgICAgIHJldHVybiB0cmVlO1xuICAgIH0sXG4gICAgKF90cmVlOiBUcmVlLCBjb250ZXh0OiBTY2hlbWF0aWNDb250ZXh0KSA9PiB7XG4gICAgICBjb250ZXh0LmFkZFRhc2sobmV3IE5vZGVQYWNrYWdlSW5zdGFsbFRhc2soKSk7XG4gICAgfSxcbiAgXSk7XG59XG4iXX0=