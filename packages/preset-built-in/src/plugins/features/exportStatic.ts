import { existsSync } from 'fs';
import { join } from 'path';
import { IApi, IRoute } from '@umijs/types';
import { deepmerge, rimraf } from '@umijs/utils';
import pathToRegexp from 'path-to-regexp';

import { isDynamicRoute } from '../utils';
import { OUTPUT_SERVER_FILENAME } from '../features/ssr/constants';

export default (api: IApi) => {
  api.describe({
    key: 'exportStatic',
    config: {
      schema(joi) {
        return joi.object({
          htmlSuffix: joi.boolean(),
          dynamicRoot: joi.boolean(),
          // 不能通过直接 patch 路由的方式，拿不到 match.[id]，是一个 render paths 的概念
          extraRoutePaths: joi
            .function()
            .description('extra render paths only enable in ssr'),
        });
      },
    },
    // TODO: api.EnableBy.config 读取的 userConfig，modifyDefaultConfig hook 修改后对这个判断不起效
    enableBy: () => api.config?.exportStatic,
  });

  api.modifyConfig((memo) => {
    if (memo.exportStatic?.dynamicRoot) {
      memo.runtimePublicPath = true;
    }
    return memo;
  });

  api.onPatchRoute(({ route }) => {
    if (!api.config.exportStatic?.htmlSuffix) return;
    if (route.path) {
      route.path = addHtmlSuffix(route.path, !!route.routes);
    }
  });

  api.onPatchRoutes(({ routes }) => {
    // copy / to /index.html
    let rootIndex = null;
    routes.forEach((route, index) => {
      if (route.path === '/' && route.exact) {
        rootIndex = index;
      }
    });
    if (rootIndex !== null) {
      routes.splice(rootIndex, 0, {
        ...routes[rootIndex],
        path: '/index.html',
      });
    }
  });

  // modify export html using routes
  api.modifyExportRouteMap(async (defaultRouteMap, { html }) => {
    const routeMap = (await html.getRouteMap()) || defaultRouteMap;
    const { exportStatic } = api.config;
    // for dynamic routes
    // TODO: test case
    if (exportStatic && typeof exportStatic.extraRoutePaths === 'function') {
      const extraRoutePaths = await exportStatic.extraRoutePaths();
      extraRoutePaths?.forEach((path) => {
        const match = routeMap.find(({ route }: { route: IRoute }) => {
          return route.path && pathToRegexp(route.path).exec(path);
        });
        if (match) {
          const newPath = deepmerge(match, {
            route: {
              path,
            },
            file: html.getHtmlPath(path),
          });
          routeMap.push(newPath);
        }
      });
    }
    return routeMap;
  });

  // 不使用 api.modifyHTML 原因是不需要转 cheerio，提高预渲染效率
  api.modifyProdHTMLContent(async (memo, args) => {
    const { route } = args;
    const serverFilePath = join(
      api.paths.absOutputPath!,
      OUTPUT_SERVER_FILENAME,
    );
    const { ssr } = api.config;
    if (
      ssr &&
      api.env === 'production' &&
      existsSync(serverFilePath) &&
      !isDynamicRoute(route.path!)
    ) {
      try {
        // do server-side render
        const render = require(serverFilePath);
        const { html, error } = await render({
          path: route.path,
          htmlTemplate: memo,
          // prevent default manifest assets generation
          manifest: {},
        });
        api.logger.info(`${route.path} render success`);
        if (!error) {
          return html;
        } else {
          api.logger.error('[SSR]', error);
        }
      } catch (e) {
        api.logger.error(`${route.path} render failed`, e);
        throw e;
      }
    }
    return memo;
  });

  api.onBuildComplete(({ err }) => {
    if (!err && api.config?.ssr && process.env.RM_SERVER_FILE !== 'none') {
      // remove umi.server.js
      const serverFilePath = join(
        api.paths.absOutputPath!,
        OUTPUT_SERVER_FILENAME,
      );
      if (existsSync(serverFilePath)) {
        rimraf.sync(serverFilePath);
      }
    }
  });

  function addHtmlSuffix(path: string, hasRoutes: boolean) {
    if (path === '/') return path;
    if (hasRoutes) {
      return path.endsWith('/') ? path : `${path}(.html)?`;
    } else {
      return path.endsWith('/') ? `${path.slice(0, -1)}.html` : `${path}.html`;
    }
  }
};
