'use strict';

/* ============================================================
 * TopK：返回数组中最大的 k 个元素；可选把「剩余元素 / 前 k 个」写到端口。
 *
 * 写法要点（也是给其它模块的样板）：
 *   · 先声明函数，再挂元数据 —— 反过来会被 `TopK = function(){}` 把元数据冲掉
 *   · 端口写入走 DSP_PORTS[name].value（描述符与数据分两个槽）
 *   · wired 由编译期决定，运行期不再判断"线有没有接"
 *   · 不就地改 fs.INPUT，避免污染上游
 * ============================================================ */

var copyOut = function (fs, which, data) {
    var p = fs.DSP_PORTS && fs.DSP_PORTS[which];
    var sw = fs.FN_SWITCHES && fs.FN_SWITCHES[which];
    if (p && p.wired && sw && sw.enabled) p.value = data;
};

function TopK(fs) {
    var arr = fs.INPUT;
    var n = arr.length;
    var args = fs.FS_ARGS || {};

    // k 防御：非法 / 缺省 → paramSchema 的默认值；超出范围截断
    var k = Number(args.K);
    if (!isFinite(k)) k = 10;
    if (k < 0) k = 0;
    if (k > n) k = n;

    // k=0：不需要排序，top 恒空，rest 就是原数组
    if (k === 0) {
        copyOut(fs, 'dupRest', arr.slice());
        copyOut(fs, 'dupOut', arr.slice(0, 0));
        return arr.slice(0, 0);          // 与 k>0 的返回类型保持一致（不返回裸 []）
    }

    // 不污染上游：复制后排序（原地 sort 会改上游数组的顺序）
    var sorted = arr.slice().sort(function (a, b) { return b - a; });
    var top = sorted.slice(0, k);

    copyOut(fs, 'dupRest', sorted.slice(k));
    copyOut(fs, 'dupOut', top);
    return top;
}

TopK.id = 'TopK';
TopK.kind = 'plain';                       // 自己读 fs、自己返回（不走 scalar/vector 适配器）
TopK.io = { in: 'num[]', out: 'num[]' };
TopK.description = '返回数组中最大的 k 个元素；可选把剩余元素 / 前 k 个写到端口';
TopK.category = '选择';
TopK.tags = '选择 最大 前k topk topn top';

TopK.paramSchema = [
    {
        name: 'K',
        label: 'K',
        type: 'number',
        default: 10,
        control: {
            shift_adjust_factor: 'inherit',
            ctrl_adjust_factor: 'inherit',
        },
    },
];

// 东南西北 ESWN 四边
TopK.copyOutSchema = {
    dupRest: {
        defaultPin: 'dsppin-S0',
        conflictPolicy: 'CW-next',
        defaultEnabled: false,
        switchable: true,
        hint: '复制剩余元素（第 k+1 个之后）',
    },
    dupOut: {
        defaultPin: 'dsppin-S1',
        conflictPolicy: 'CW-next',
        defaultEnabled: false,
        switchable: true,
        hint: '复制前 k 个（= 返回值的那份）',
    },
};

if (typeof registerFunction === 'function') registerFunction(TopK);
else DSPFunctions.push(TopK);
