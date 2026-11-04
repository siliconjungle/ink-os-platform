// An order-statistics treap. Index shape has no semantic significance; random
// priorities prevent caller-selected row IDs from constructing a degenerate tree.
const size = (node) => node?.size || 0;
const update = (node) => {
  if (node) node.size = 1 + size(node.left) + size(node.right);
  return node;
};
const rotateRight = (node) => {
  const root = node.left;
  node.left = root.right;
  root.right = update(node);
  return update(root);
};
const rotateLeft = (node) => {
  const root = node.right;
  node.right = root.left;
  root.left = update(node);
  return update(root);
};
export class OrderedIndex {
  constructor(compare) {
    this.compare = compare;
    this.root = null;
  }
  insert(key, value) {
    const put = (node) => {
      if (!node)
        return {
          key,
          value,
          priority: Math.random(),
          size: 1,
          left: null,
          right: null,
        };
      const order = this.compare(key, node.key);
      if (!order) {
        node.value = value;
        return node;
      }
      if (order < 0) {
        node.left = put(node.left);
        if (node.left.priority < node.priority) node = rotateRight(node);
      } else {
        node.right = put(node.right);
        if (node.right.priority < node.priority) node = rotateLeft(node);
      }
      return update(node);
    };
    this.root = put(this.root);
  }
  remove(key) {
    const merge = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (a.priority < b.priority) {
        a.right = merge(a.right, b);
        return update(a);
      }
      b.left = merge(a, b.left);
      return update(b);
    };
    const remove = (node) => {
      if (!node) return null;
      const order = this.compare(key, node.key);
      if (!order) return merge(node.left, node.right);
      if (order < 0) node.left = remove(node.left);
      else node.right = remove(node.right);
      return update(node);
    };
    this.root = remove(this.root);
  }
  rank(key, stats) {
    let count = 0,
      node = this.root;
    while (node) {
      if (stats) stats.indexNodes++;
      if (this.compare(node.key, key) < 0) {
        count += 1 + size(node.left);
        node = node.right;
      } else node = node.left;
    }
    return count;
  }
  get size() {
    return size(this.root);
  }
  *range(start = 0, end = this.size, reverse = false, stats) {
    function* visit(node, base) {
      if (!node || base >= end || base + size(node) <= start) return;
      if (stats) stats.indexNodes++;
      const at = base + size(node.left);
      if (reverse) {
        yield* visit(node.right, at + 1);
        if (at >= start && at < end) yield node.value;
        yield* visit(node.left, base);
      } else {
        yield* visit(node.left, base);
        if (at >= start && at < end) yield node.value;
        yield* visit(node.right, at + 1);
      }
    }
    yield* visit(this.root, 0);
  }
}
