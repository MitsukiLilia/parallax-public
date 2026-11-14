// 新版 node 把 `node --test test/` 的参数当通配符:匹配到的是目录本身,随后按模块解析落到这个文件。
// 这里只负责把真正的测试文件加载进来,测试本身都在 unit.test.mjs。
import('./unit.test.mjs');
